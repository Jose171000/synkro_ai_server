import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { AmbitoDeGrupo, ProductGroupsService } from './product-groups.service';
import { SyncService } from '../sync/sync.service';
import { RipleyCatalogoService } from '../sync/ripley/ripley-catalogo.service';
import { infoDeVariantesDeRipley } from '../sync/ripley/ripley-catalogo';
import { AiService } from '../ai/ai.service';
import { CategorySeederService } from '../categories/category-seeder.service';
import { VectorSearchService } from '../categories/vector-search.service';
import { categoriasElegidas } from '../ai/categorias-elegidas';
import { EjeSynkro, InfoVariantesDeCategoria, NOMBRE_DE_CANAL, ResultadoDeCompatibilidad, claseDeEje, revisarCompatibilidad } from './compatibilidad-variantes';
import { normalizar } from '../ai/ripley-atributos';
import { ajustesDe, guardarAjustes, opcionDeLaLista, valorConAjuste } from './ajustes-de-canal';
import { atributosConVariante } from './titulos-de-variante';
import { opcionCercana } from '../common/opcion-cercana';
import { ejesQueSeparanFamilias } from '../sync/falabella/falabella-fields';

/** Valores de un dato del canal (color, talla, tamaño) que no encajan, con lo que la IA propone para cada uno. La persona confirma antes de aplicar. */
export interface SugerenciaDeAjustes {
    eje: string;
    /** El dato del canal al que corresponde el eje, y sus opciones válidas. */
    atributo: string;
    opciones: string[];
    items: { valor: string; opcion: string | null; motivo: string; origen: 'ia' | 'foto' | 'actual' | null; conflicto: boolean }[];
    /** Dato de la misma clase que el principal (Falabella: «Color básico»): su ajuste es propio, solo vale para ese dato. */
    derivado?: boolean;
}

/** Lo que un canal rechazó de UNA variante: un dato de lista cerrada cuyo valor no está en la lista, con lo que propone la IA. */
export interface CorreccionDeVariante {
    /** La variante no tiene categoría en ese canal: sin ella no hay listas que revisar. */
    sinCategoria?: boolean;
    items: { atributo: string; valor: string; opciones: string[]; opcion: string | null; motivo: string; origen: 'ia' | 'foto' | 'actual' | null }[];
}

/** Cuántas categorías parecidas se verifican con la IA al buscar una recomendación (cada verificación es una consulta). */
const MAX_VERIFICACIONES = 4;
/** Shopify admite hasta 3 opciones de variante por producto. */
const MAX_EJES_SHOPIFY = 3;

/** Recomendaciones de renombre ya calculadas (la pantalla vuelve a pedir la revisión): no se repite la consulta a la IA durante una hora. */
const CACHE_DE_RENOMBRES = new Map<string, { a: string | null; hasta: number }>();
const UNA_HORA = 3600_000;

export interface PedidoDeCompatibilidad { marketplace: string; categoryId?: string }

/**
 * Revisa, por canal, si las variantes de un grupo (con los ejes que configuró la persona) caben en UNA sola publicación según la
 * categoría que tienen en ese canal. Si no caben se publican como productos separados y se avisa. Cuando es por la categoría,
 * recomienda otra parecida que SÍ las admite, sin cambiarla: manda la que mejor encaja con el producto.
 * Solo consulta: no cambia nada.
 */
@Injectable()
export class VariantCompatService {
    private readonly logger = new Logger('CompatibilidadDeVariantes');

    constructor(
        private readonly grupos: ProductGroupsService,
        @InjectRepository(Product) private readonly productos: Repository<Product>,
        private readonly sync: SyncService,
        private readonly ripley: RipleyCatalogoService,
        private readonly ai: AiService,
        private readonly semilla: CategorySeederService,
        private readonly vectores: VectorSearchService,
    ) { }

    async revisar(grupoId: string, pedidos: PedidoDeCompatibilidad[], ambito: AmbitoDeGrupo): Promise<ResultadoDeCompatibilidad[]> {
        const vista = await this.grupos.obtener(grupoId, ambito);
        const variantes = await this.productos.find({ where: { group: { id: grupoId } }, order: { createdAt: 'ASC' } });
        // La categoría de cada canal es la que ya tiene el grupo (en cualquiera de sus variantes), salvo que la pantalla pida otra.
        const guardadas = variantes.reduce((acc, v) => ({ ...categoriasElegidas(v.marketplaceIds as any, v.aiAttributes as any), ...acc }), {} as Record<string, string>);
        const salida: ResultadoDeCompatibilidad[] = [];

        for (const pedido of pedidos) {
            const canal = String(pedido.marketplace ?? '').toLowerCase();
            const categoryId = pedido.categoryId?.trim() || guardadas[canal] || null;
            const info = this.conReglas(await this.infoDe(ambito, canal, categoryId), canal, variantes);
            if (!info) continue;
            const r = revisarCompatibilidad(vista.axes as EjeSynkro[], info);
            if (r.publicaComo === 'separadas' && !info.libre) {
                r.recomendada = await this.recomendar(canal, categoryId, vista.name, vista.axes as EjeSynkro[], variantes).catch((e: any) => {
                    this.logger.warn(`No se pudo buscar una categoría de ${canal} que admita las variantes: ${e?.message}`);
                    return null;
                });
            }
            // Falabella guarda el tamaño una sola vez por familia: si la categoría no lo admite como variación, cada tamaño sale como familia propia.
            if (canal === 'falabella' && !info.libre) {
                const aparte = ejesQueSeparanFamilias(vista.axes as EjeSynkro[], info.ejes.map((e) => ({ name: e.id, label: e.label })));
                if (aparte.length) r.avisos.push(`En Falabella «${aparte.join(', ')}» no es un dato de variación de esta categoría: cada valor se publicará como una familia propia (con sus colores dentro), para que cada ficha lleve el tamaño correcto.`);
            }
            if (r.ejesNoPermitidos.length && r.ejesDisponibles.length) r.renombresSugeridos = await this.sugerirRenombres(vista.name, vista.axes as EjeSynkro[], r);
            salida.push(r);
        }
        return salida;
    }

    /**
     * Para cada eje que el canal no acepta, a qué dato libre del canal corresponde (la IA mira los valores). Solo recomienda; la persona confirma.
     * Si la IA no está segura o falla, no recomienda nada y la pantalla deja elegir de la lista.
     */
    private async sugerirRenombres(producto: string, ejes: EjeSynkro[], r: ResultadoDeCompatibilidad): Promise<{ eje: string; a: string }[]> {
        const salida: { eje: string; a: string }[] = [];
        const usadas = new Set<string>();
        for (const nombre of r.ejesNoPermitidos) {
            const eje = ejes.find((e) => e.name === nombre);
            const opciones = r.ejesDisponibles.filter((o) => !usadas.has(o.toLowerCase()));
            if (!eje || !opciones.length) continue;
            const clave = JSON.stringify([producto, nombre, eje.values, opciones]);
            let a: string | null;
            const guardada = CACHE_DE_RENOMBRES.get(clave);
            if (guardada && guardada.hasta > Date.now()) a = guardada.a;
            else {
                a = await Promise.resolve(this.ai.sugerirRenombreDeEje({ producto, eje: nombre, valores: eje.values, opciones })).catch(() => null);
                CACHE_DE_RENOMBRES.set(clave, { a, hasta: Date.now() + UNA_HORA });
            }
            if (a) { salida.push({ eje: nombre, a }); usadas.add(a.toLowerCase()); }
        }
        return salida;
    }

    /**
     * Añade a lo que admite el canal los ajustes que la persona ya confirmó (de cualquier variante del grupo) y la regla automática
     * con la que ese canal lleva un valor a su lista, que debe ser la misma que usa al publicar.
     */
    private conReglas(info: InfoVariantesDeCategoria | null, canal: string, variantes: Product[]): InfoVariantesDeCategoria | null {
        if (!info) return info;
        const ajustes: Record<string, Record<string, string>> = {};
        for (const v of variantes) {
            for (const [clase, valores] of Object.entries(ajustesDe(v.aiAttributes as any, canal))) ajustes[clase] = { ...(ajustes[clase] ?? {}), ...valores };
        }
        return { ...info, ajustes, ...(canal === 'falabella' || canal === 'mercadolibre' ? { automatico: (valor: string, opciones: string[]) => opcionCercana(valor, opciones) } : {}) };
    }

    /**
     * Los datos de lista cerrada del canal cuyo valor, EN ESTA VARIANTE, no está en la lista (con la misma regla que usa el canal al
     * publicar: el ajuste confirmado si lo hay y, si no, la opción más cercana). Son justo los que el canal rechaza.
     */
    private async datosRechazados(product: Product, canal: string, ambito: AmbitoDeGrupo): Promise<{ atributo: string; valor: string; opciones: string[] }[]> {
        const categoria = categoriasElegidas(product.marketplaceIds as any, product.aiAttributes as any)[canal];
        if (!categoria) return [];
        const guardados = (product.aiAttributes as any) || {};
        const salida: { atributo: string; valor: string; opciones: string[] }[] = [];
        if (canal === 'mercadolibre') {
            const listas = await this.sync.listasCerradasMeli(String(categoria));
            const actuales = this.sync.atributosParaMeli(product);
            for (const d of listas) {
                const valor = actuales.find((x) => x.id === d.id)?.value_name;
                if (!valor || !String(valor).trim()) continue;
                const ok = valorConAjuste({ canal, atributos: guardados, atributo: d.label, valor: String(valor), opciones: d.options, automatico: (v, o) => opcionCercana(v, o) });
                if (ok === undefined) salida.push({ atributo: d.label, valor: String(valor), opciones: d.options });
            }
        } else if (canal === 'falabella') {
            const campos = await this.sync.getFalabellaCategoryFields(ambito, String(categoria));
            const conVariante = atributosConVariante(guardados, product.variantValues);
            for (const c of campos) {
                if (!c.options?.length) continue;
                const valor = this.sync.buscarAtributo(conVariante, c.name);
                if (valor === undefined || valor === null || !String(valor).trim()) continue;
                const ok = valorConAjuste({ canal, atributos: guardados, atributo: c.label || c.name, valor: String(valor), opciones: c.options, automatico: (v, o) => opcionCercana(v.trim(), o) });
                if (ok === undefined) salida.push({ atributo: c.label || c.name, valor: String(valor), opciones: c.options });
            }
        } else {
            throw new BadRequestException('Por ahora solo Mercado Libre y Falabella.');
        }
        return salida;
    }

    private async variante(productId: string, ambito: AmbitoDeGrupo): Promise<Product> {
        await this.sync.findScopedProduct(ambito, productId); // comprueba que es de esta tienda
        const p = await this.productos.findOne({ where: { id: productId }, relations: { images: true, group: true } });
        if (!p) throw new BadRequestException('Producto no encontrado.');
        return p;
    }

    /**
     * Qué rechazó el canal de UNA variante y qué opción válida corresponde: la IA propone (mirando el nombre y la foto) y, si no puede,
     * se devuelven igual las opciones que el canal sí acepta para que la persona elija ahí mismo. Solo consulta.
     */
    async sugerirCorreccion(productId: string, marketplace: string, ambito: AmbitoDeGrupo): Promise<CorreccionDeVariante> {
        const canal = String(marketplace ?? '').toLowerCase();
        const product = await this.variante(productId, ambito);
        if (!categoriasElegidas(product.marketplaceIds as any, product.aiAttributes as any)[canal]) return { sinCategoria: true, items: [] };
        const rechazados = await this.datosRechazados(product, canal, ambito);
        const imagen = product.images?.find((i) => i.url)?.url ?? null;
        const items: CorreccionDeVariante['items'] = [];
        for (const r of rechazados) {
            const [s] = await Promise.resolve(this.ai.sugerirOpcionesDeLista({
                canal: NOMBRE_DE_CANAL[canal] ?? canal, producto: product.name, dato: r.atributo.replace(/\s*variant$/i, '').trim(),
                opciones: r.opciones, valores: [{ valor: r.valor, imagen }],
            })).catch(() => []);
            items.push({
                atributo: r.atributo, valor: r.valor, opciones: r.opciones,
                opcion: s?.opcion ?? null,
                motivo: s?.opcion ? s.motivo : 'La IA no encontró una opción clara: elige una de las que acepta el canal.',
                origen: s?.opcion ? s.origen : null,
            });
        }
        return { items };
    }

    /** Guarda, solo para ese canal, la opción elegida para cada dato rechazado. El valor de la persona no cambia en Synkro ni en otros canales. */
    async aplicarCorreccion(productId: string, marketplace: string, cambios: { atributo: string; valor: string; opcion: string }[], ambito: AmbitoDeGrupo): Promise<{ aplicados: number }> {
        const canal = String(marketplace ?? '').toLowerCase();
        const product = await this.variante(productId, ambito);
        const rechazados = await this.datosRechazados(product, canal, ambito);
        const validos: { clase: string; valor: string; opcion: string }[] = [];
        for (const c of cambios ?? []) {
            const r = rechazados.find((x) => normalizar(x.atributo) === normalizar(c.atributo) && x.valor === c.valor);
            if (!r) throw new BadRequestException(`«${c.atributo}» ya no tiene un valor rechazado en ${NOMBRE_DE_CANAL[canal] ?? canal}.`);
            const opcion = opcionDeLaLista(c.opcion, r.opciones);
            if (!opcion) throw new BadRequestException(`«${c.opcion}» no es una opción válida de ${NOMBRE_DE_CANAL[canal] ?? canal} para «${c.atributo}».`);
            // Mercado Libre: el ajuste vale para el color en general; Falabella: solo para ese dato («Color básico»), con su propia lista.
            const clase = canal === 'falabella' ? `${claseDeEje(c.atributo)}@${normalizar(c.atributo)}` : claseDeEje(c.atributo);
            validos.push({ clase, valor: c.valor, opcion });
        }
        if (!validos.length) return { aplicados: 0 };
        const variantes = product.group ? await this.productos.find({ where: { group: { id: product.group.id } } }) : [product];
        for (const v of variantes) {
            v.aiAttributes = guardarAjustes(v.aiAttributes as any, canal, validos) as any;
            await this.productos.save(v);
        }
        return { aplicados: validos.length };
    }

    /**
     * Para un canal con listas cerradas: los valores del grupo que no encajan (o que caerían en la misma opción) con lo que la IA propone
     * para cada uno, mirando el nombre del producto y, si hace falta, la foto de la variante. Solo consulta: no cambia nada.
     */
    async sugerirAjustes(grupoId: string, marketplace: string, ambito: AmbitoDeGrupo): Promise<SugerenciaDeAjustes[]> {
        const canal = String(marketplace ?? '').toLowerCase();
        const vista = await this.grupos.obtener(grupoId, ambito);
        const variantes = await this.productos.find({ where: { group: { id: grupoId } }, order: { createdAt: 'ASC' }, relations: { images: true } });
        const guardadas = variantes.reduce((acc, v) => ({ ...categoriasElegidas(v.marketplaceIds as any, v.aiAttributes as any), ...acc }), {} as Record<string, string>);
        const info = this.conReglas(await this.infoDe(ambito, canal, guardadas[canal] ?? null), canal, variantes);
        if (!info || info.libre) return [];
        const r = revisarCompatibilidad(vista.axes as EjeSynkro[], info);

        const salida: SugerenciaDeAjustes[] = [];
        for (const par of r.mapeo) {
            const atributo = info.ejes.find((a) => a.id === par.atributo);
            if (!atributo?.options?.length) continue;
            const sinEquivalente = r.valoresSinEquivalente.find((e) => e.eje === par.eje)?.valores ?? [];
            const colisionan = r.colisiones.filter((c) => c.eje === par.eje);
            const enConflicto = new Set(colisionan.flatMap((c) => c.valores));
            const objetivo = [...new Set([...sinEquivalente, ...enConflicto])];
            if (!objetivo.length) continue;

            const imagenDe = (valor: string) => variantes.find((v) => (v.variantValues as any)?.[par.eje] === valor)?.images?.find((i) => i.url)?.url ?? null;
            const sugeridas = await this.ai.sugerirOpcionesDeLista({
                canal: NOMBRE_DE_CANAL[canal] ?? canal, producto: vista.name, dato: String(atributo.label).replace(/\s*variant$/i, '').trim(),
                opciones: atributo.options,
                valores: objetivo.map((valor) => ({ valor, imagen: imagenDe(valor), enConflicto: enConflicto.has(valor) })),
            });
            salida.push({
                eje: par.eje, atributo: atributo.label, opciones: atributo.options,
                items: objetivo.map((valor) => {
                    const s = sugeridas.find((x) => x.valor === valor);
                    const actual = colisionan.find((c) => c.valores.includes(valor))?.opcion ?? null;
                    return {
                        valor, conflicto: enConflicto.has(valor),
                        opcion: s?.opcion ?? actual,
                        motivo: s?.opcion ? s.motivo : (actual ? 'Es la opción más cercana que encontró el sistema.' : 'La IA no encontró una opción clara: elige una de la lista.'),
                        origen: s?.opcion ? s.origen : (actual ? 'actual' : null),
                    };
                }),
            });
        }
        // Los datos de la misma clase con otra lista («Color básico») que quedaron sin opción: la IA elige UNA vez por valor, mirando el nombre y la
        // foto, y solo entre las opciones de ESA lista. Así todas las tallas de un color salen con lo mismo.
        for (const d of r.detalle.filter((x) => x.derivado)) {
            const objetivo = d.items.filter((i) => i.estado === 'sin').map((i) => i.valor);
            if (!objetivo.length) continue;
            const imagenDe = (valor: string) => variantes.find((v) => (v.variantValues as any)?.[d.eje] === valor)?.images?.find((i) => i.url)?.url ?? null;
            const sugeridas = await this.ai.sugerirOpcionesDeLista({
                canal: NOMBRE_DE_CANAL[canal] ?? canal, producto: vista.name, dato: d.atributo, opciones: d.opciones,
                valores: objetivo.map((valor) => ({ valor, imagen: imagenDe(valor) })),
            });
            salida.push({
                eje: d.eje, atributo: d.atributo, opciones: d.opciones, derivado: true,
                items: objetivo.map((valor) => {
                    const s = sugeridas.find((x) => x.valor === valor);
                    return {
                        valor, conflicto: false, opcion: s?.opcion ?? null,
                        motivo: s?.opcion ? s.motivo : 'La IA no encontró una opción clara: elige una de la lista.',
                        origen: s?.opcion ? s.origen : null,
                    };
                }),
            });
        }
        return salida;
    }

    /**
     * Guarda, para ese canal, a qué opción válida corresponde cada valor que la persona confirmó. Se guarda en todas las variantes del grupo
     * (el valor no cambia en Synkro ni en los demás canales). Solo acepta opciones que existan en la lista del canal.
     */
    async aplicarAjustes(grupoId: string, marketplace: string, cambios: { eje: string; valor: string; opcion: string; atributo?: string }[], ambito: AmbitoDeGrupo): Promise<{ aplicados: number; variantes: number }> {
        const canal = String(marketplace ?? '').toLowerCase();
        const vista = await this.grupos.obtener(grupoId, ambito);
        const variantes = await this.productos.find({ where: { group: { id: grupoId } } });
        const guardadas = variantes.reduce((acc, v) => ({ ...categoriasElegidas(v.marketplaceIds as any, v.aiAttributes as any), ...acc }), {} as Record<string, string>);
        const info = await this.infoDe(ambito, canal, guardadas[canal] ?? null);
        if (!info || info.libre) throw new BadRequestException('Este canal no tiene listas cerradas que ajustar.');
        const r = revisarCompatibilidad(vista.axes as EjeSynkro[], info);

        const validos: { clase: string; valor: string; opcion: string }[] = [];
        for (const c of cambios ?? []) {
            const par = r.mapeo.find((m) => m.eje === c.eje);
            // Con `atributo`: el ajuste es de ese dato concreto (p. ej. «Color básico»), con su propia lista; sin él, del dato principal del eje.
            const derivado = c.atributo ? r.detalle.find((d) => d.derivado && d.eje === c.eje && normalizar(d.atributo) === normalizar(c.atributo!)) : undefined;
            if (c.atributo && !derivado) throw new BadRequestException(`«${c.atributo}» no es un dato de ${NOMBRE_DE_CANAL[canal] ?? canal} que se pueda ajustar para «${c.eje}».`);
            const opciones = derivado ? derivado.opciones : info.ejes.find((a) => a.id === par?.atributo)?.options ?? [];
            const opcion = opcionDeLaLista(c.opcion, opciones);
            if (!par || !opcion) throw new BadRequestException(`«${c.opcion}» no es una opción válida de ${NOMBRE_DE_CANAL[canal] ?? canal} para «${c.atributo ?? c.eje}».`);
            const claseDelAjuste = derivado?.claveDeAjuste ?? claseDeEje(c.eje);
            validos.push({ clase: claseDelAjuste, valor: c.valor, opcion });
        }
        if (!validos.length) return { aplicados: 0, variantes: 0 };
        for (const v of variantes) {
            v.aiAttributes = guardarAjustes(v.aiAttributes as any, canal, validos) as any;
            await this.productos.save(v);
        }
        return { aplicados: validos.length, variantes: variantes.length };
    }

    /**
     * Categorías de Falabella que agrupan por talla y color sin campos «…Variant»: el color y la talla son los datos «Color» y «Talla» de la
     * categoría. Se devuelven CON sus listas, para que la revisión avise de los valores que Falabella no tiene (un color «Leopardo») y la
     * persona pueda elegir a qué opción corresponde. Sin la lista no se podía comprobar nada y la pantalla no ofrecía opciones.
     */
    private async ejesDeTallaYColor(ambito: AmbitoDeGrupo, categoryId: string): Promise<{ ejes: { id: string; label: string; options?: string[] }[]; extras: { id: string; label: string; options: string[] }[] }> {
        let campos: { name: string; label: string; options?: string[] }[] = [];
        try { campos = await this.sync.getFalabellaCategoryFields(ambito, categoryId); } catch { /* sin lista: se revisa sin comprobar valores */ }
        const lista = (clase: string, exacto: string) => {
            const delaClase = campos.filter((c) => c.options?.length && claseDeEje(c.label || c.name) === clase);
            return (delaClase.find((c) => normalizar(c.name) === exacto) ?? delaClase[0])?.options;
        };
        const color = lista('color', 'color');
        const talla = lista('talla', 'talla');
        const ejes = [{ id: 'Color', label: 'Color', ...(color?.length ? { options: color } : {}) }, { id: 'Talla', label: 'Talla', ...(talla?.length ? { options: talla } : {}) }];
        // Otros datos de color o talla con lista cerrada («Color básico»): no se eligen aparte, pero se muestra qué saldrá en cada uno.
        const extras = campos
            .filter((c) => c.options?.length && ['color', 'talla'].includes(claseDeEje(c.label || c.name)) && normalizar(c.name) !== 'color' && normalizar(c.name) !== 'talla')
            .map((c) => ({ id: c.name, label: c.label || c.name, options: c.options! }));
        return { ejes, extras };
    }

    /** Lo que admite la categoría del canal; null si no se puede saber (sin categoría, sin cuenta conectada o el canal no responde). */
    private async infoDe(ambito: AmbitoDeGrupo, canal: string, categoryId: string | null): Promise<InfoVariantesDeCategoria | null> {
        try {
            if (canal === 'shopify') return { canal, categoryId: null, admite: true, ejes: [], libre: true, maxEjes: MAX_EJES_SHOPIFY };
            if (canal === 'woocommerce') return { canal, categoryId: null, admite: true, ejes: [], libre: true };
            if (!categoryId) return null;

            if (canal === 'ripley') {
                const c = await this.ripley.campos(categoryId);
                const listas = new Map<string, string[]>();
                for (const campo of c.campos.filter((x) => x.isVariant && x.listCode)) listas.set(campo.listCode!, campo.options ?? await this.ripley.listaCompleta(campo.listCode!));
                return {
                    canal, categoryId, ruta: c.path, admite: c.admiteVariantes,
                    ejes: c.campos.filter((x) => x.isVariant).map((x) => ({ id: x.name, label: x.label, required: x.required, ...((x.listCode && listas.get(x.listCode)?.length) ? { options: listas.get(x.listCode) } : {}) })),
                };
            }
            if (canal === 'falabella') {
                const r = await this.sync.falabellaCategoryVariants(ambito, categoryId);
                const tallaYColor = !r.camposDeVariacion.length && r.porTallaYColor ? await this.ejesDeTallaYColor(ambito, categoryId) : null;
                const ejes = r.camposDeVariacion.length
                    ? r.camposDeVariacion.map((c) => ({ id: c.name, label: c.label, required: !!c.required, ...(c.options?.length ? { options: c.options } : {}) }))
                    : tallaYColor?.ejes ?? [];
                return { canal, categoryId, admite: r.admiteVariantes, ejes, ...(tallaYColor?.extras.length ? { extras: tallaYColor.extras } : {}) };
            }
            if (canal === 'mercadolibre') {
                const ejes = await this.sync.ejesDeVariacionMeli(categoryId);
                // Datos de color o talla con lista cerrada que no son el eje («Color principal»): Mercado Libre rechaza un color que no esté en su lista.
                let listas: { id: string; label: string; options: string[] }[] = [];
                // Sin esa lista el canal se revisa igual, solo con los ejes.
                try { listas = await this.sync.listasCerradasMeli(categoryId); } catch { /* se sigue sin extras */ }
                const extras = listas.filter((l) => !ejes.some((e) => e.id === l.id) && ['color', 'talla'].includes(claseDeEje(l.label || l.id)));
                return { canal, categoryId, admite: ejes.length > 0, ejes, ...(extras.length ? { extras } : {}) };
            }
        } catch (error: any) {
            this.logger.warn(`No se pudo saber qué variantes admite la categoría ${categoryId} de ${canal}: ${error?.message}`);
        }
        return null;
    }

    /**
     * Otra categoría, parecida al producto y verificada por la IA, que SÍ admite los ejes del producto. Nunca reemplaza a la
     * actual: solo se ofrece. Ripley se busca entre sus categorías guardadas; Falabella la deja anotada la preparación (`_categoriaConVariantes`).
     */
    private async recomendar(canal: string, actual: string | null, nombre: string, ejes: EjeSynkro[], variantes: Product[]): Promise<{ id: string; ruta: string } | null> {
        if (canal === 'falabella') {
            const r = variantes.map((v) => (v.aiAttributes as any)?._categoriaConVariantes?.falabella).find((x) => x?.id);
            return r ? { id: String(r.id), ruta: String(r.path ?? r.id) } : null;
        }
        if (canal !== 'ripley') return null;

        const texto = [nombre, ...ejes.map((e) => `${e.name}: ${e.values.join(', ')}`)].join('. ');
        const candidatas = await this.vectores.findSimilarCategories(await this.semilla.generateEmbedding(texto), 'ripley', 25);
        const descripcion = variantes[0]?.aiDescription || variantes[0]?.description || nombre;
        let verificadas = 0;
        for (const c of candidatas) {
            if (c.categoryId === actual) continue;
            const info = infoDeVariantesDeRipley(c.categoryId, c.name, c.requiredAttributes);
            if (revisarCompatibilidad(ejes, info).publicaComo !== 'una') continue;
            if (++verificadas > MAX_VERIFICACIONES) break;
            const v = await this.ai.verificarCategoria(nombre, descripcion, null, c.name);
            if (v.ok && !v.incierta) return { id: c.categoryId, ruta: c.name };
        }
        return null;
    }
}
