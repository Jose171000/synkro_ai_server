import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { MarketplaceCategory } from '../categories/entities/marketplace-category.entity';
import { VectorSearchService } from '../categories/vector-search.service';
import { CategorySeederService } from '../categories/category-seeder.service';
import { SyncScope, SyncService } from '../sync/sync.service';
import { FalabellaApiService } from '../sync/falabella/falabella-api.service';
import { AiService } from './ai.service';
import { ChannelAttributesService } from './channel-attributes.service';
import { ProductVision, ProductVisionService } from './product-vision.service';
import { ATRIBUTOS_DE_SISTEMA, claveDeAtributo, esAtributoDeSistema } from '../sync/falabella/falabella-fields';
import { extraerUrlsDeImagen, quitarUrls } from './description-html';
import { huellaDeFotos, necesitaVision } from './vision-fotos';

export interface FalabellaPrepReport {
    sku?: string;
    listo: boolean;
    motivo?: string;
    category: { id: string; path: string; auto: boolean; /** alta: verificada; baja: conviene revisarla; manual: la eligió una persona */ confidence?: 'alta' | 'baja' | 'manual' } | null;
    /** Por qué la categoría necesita revisión, si la necesita. */
    categoryNote?: string;
    /** Las categorías más cercanas al producto, para elegir a mano cuando ninguna encajó del todo. */
    categoryOptions?: { id: string; path: string }[];
    brand: { value: string; replaced: boolean; original?: string };
    measures: { width: number | null; length: number | null; height: number | null; weight: number | null; estimated: boolean };
    estimatedAttributes: string[];
    /** Se redactó la descripción HTML estándar en este paso. */
    descriptionGenerated: boolean;
    /** Cuántos atributos de la categoría tienen valor tras este paso, de cuántos hay. */
    attributes: { filled: number; total: number };
}

/** Cuántas categorías cercanas se ofrecen cuando ninguna encajó del todo. */
const MAX_SUGERIDAS = 5;

/** Datos que la plataforma ya cubre por su cuenta al publicar en Falabella. */
const CUBIERTOS = ATRIBUTOS_DE_SISTEMA;

/** Campos de sistema (ya no se envían) con su nombre normalizado, para no mostrarlos como «estimados». */
const sistema = new Set([...ATRIBUTOS_DE_SISTEMA].map(claveDeAtributo));

const normalizar = (t: string) => t.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/**
 * Deja un producto listo para Falabella con un solo paso: elige su categoría, comprueba la marca contra el
 * catálogo, estima las medidas del paquete y completa los datos obligatorios de la categoría.
 * Todo lo que no vino del cliente queda marcado para que se pueda revisar.
 */
@Injectable()
export class FalabellaAutoPrepService implements OnModuleInit {
    private readonly logger = new Logger(FalabellaAutoPrepService.name);

    constructor(
        private readonly sync: SyncService,
        private readonly falabella: FalabellaApiService,
        private readonly ai: AiService,
        private readonly canales: ChannelAttributesService,
        private readonly vectores: VectorSearchService,
        private readonly seeder: CategorySeederService,
        @InjectRepository(Product)
        private readonly products: Repository<Product>,
        private readonly vision: ProductVisionService,
    ) { }

    /** Las categorías de Falabella más cercanas al producto: por significado primero y, si faltan, por palabras. */
    private async candidatasDe(nombre: string, descripcion: string, vision: ProductVision | null, creds: any): Promise<MarketplaceCategory[]> {
        let candidatas: MarketplaceCategory[] = [];
        try {
            const emb = await this.seeder.generateEmbedding(`${nombre} ${descripcion.slice(0, 300)}`);
            candidatas = await this.vectores.findSimilarCategories(emb, 'falabella', 8);
        } catch (error: any) {
            this.logger.warn(`Búsqueda por significado no disponible: ${error?.message}`);
        }
        if (candidatas.length < 3) {
            const palabras = [vision?.productType ?? '', ...(vision?.keywords ?? []), ...nombre.split(/\s+/)].filter(Boolean);
            candidatas = [...candidatas, ...(await this.canales.candidatasFalabella(creds, palabras))].slice(0, 25);
        }
        return candidatas;
    }

    private async admiteVariantes(scope: SyncScope, categoryId: string, connectionId: string): Promise<boolean> {
        try {
            return (await this.sync.falabellaCategoryVariants(scope, categoryId, connectionId)).admiteVariantes;
        } catch {
            return false;
        }
    }

    /** La categoría más cercana que admite variantes Y que la IA confirma que corresponde al producto (revisa hasta 8 candidatas). */
    private async categoriaQueAdmiteVariantes(
        scope: SyncScope, connectionId: string, creds: any, excluir: string[], nombre: string, descripcion: string, vision: ProductVision | null,
    ): Promise<{ id: string; path: string } | null> {
        const candidatas = await this.candidatasDe(nombre, descripcion, vision, creds);
        let revisadas = 0;
        for (const c of candidatas) {
            const id = String(c.categoryId);
            if (excluir.includes(id)) continue;
            if (++revisadas > 8) break;
            if (!(await this.admiteVariantes(scope, id, connectionId))) continue;
            const v = await this.ai.verificarCategoria(nombre, descripcion, vision, c.name);
            if (v.ok) return { id, path: c.name };
        }
        return null;
    }

    async preparar(scope: SyncScope, productId: string, connectionId?: string, opciones: { regenerar?: boolean } = {}): Promise<FalabellaPrepReport> {
        const product = await this.sync.findScopedProduct(scope, productId);
        const connection = await this.sync.resolveConnection(scope.storeId, 'falabella', connectionId);
        const creds = this.sync.credentialsOf(connection);

        let attrs: Record<string, any> = { ...((product.aiAttributes as any) || {}) };
        const ids: Record<string, any> = { ...((product.marketplaceIds as any) || {}) };
        const nombre = product.aiTitle || product.name;
        const descripcion = product.aiDescription || product.description || nombre;
        let vision = (attrs.vision as ProductVision | undefined) ?? null;
        const estimated = { measures: !!attrs.estimated?.measures, attributes: { ...(attrs.estimated?.attributes ?? {}) } as Record<string, string[]> };

        // ── Fotos: lo que se ve en ellas ──
        // Un producto que no nació con IA (por ejemplo, uno importado de un canal) no tiene guardado lo que muestran sus fotos. Se
        // analizan cuando nunca se hizo, cuando las fotos cambiaron desde el último análisis o cuando la persona pide rehacerlo.
        // Si el análisis falla se conserva lo que hubiera y se vuelve a intentar la próxima vez.
        const fotos = (product.images ?? []).map((i) => i.url).filter(Boolean);
        if (necesitaVision(attrs, fotos, opciones.regenerar)) {
            const nueva = await this.vision.analyze(fotos, { name: product.name, description: quitarUrls(product.description) });
            if (nueva) {
                vision = nueva;
                attrs.vision = nueva;
                attrs._visionFotos = huellaDeFotos(fotos);
                // Lo que se ve rellena la marca y el color solo si estaban vacíos.
                if (!String(attrs.brand ?? '').trim() && nueva.brand) attrs.brand = nueva.brand;
                if (!String(attrs.color ?? '').trim() && nueva.color) attrs.color = nueva.color;
            }
        }

        // ── Categoría ──
        // Las que Falabella ya rechazó para este producto no se vuelven a proponer.
        const descartadas: string[] = (attrs._categoriasMalas?.falabella ?? []).map(String);
        let categoryId = this.sync.categoriaFalabella(product);
        let categoriaAuto = false;
        let confianza: 'alta' | 'baja' | 'manual' | null = categoryId && String(attrs._categoriaManual) === String(categoryId) ? 'manual' : null;

        // Una categoría que aún nadie verificó (la puso la IA antes de esta comprobación) se revisa una vez.
        if (categoryId && confianza !== 'manual' && String(attrs._categoriaVerificada) !== String(categoryId)) {
            const ruta = (await this.falabella.getCategories(creds).catch((): { id: string; path: string }[] => [])).find((c) => c.id === String(categoryId))?.path;
            if (ruta) {
                const v = await this.ai.verificarCategoria(nombre, descripcion, vision, ruta);
                if (v.ok) attrs._categoriaVerificada = String(categoryId);
                else {
                    descartadas.push(String(categoryId));
                    delete ids.falabella_category_id;
                    delete attrs.falabella_category_id;
                    categoryId = undefined;
                }
            }
        }
        if (categoryId && confianza !== 'manual') confianza = attrs._categoriaDudosa ? 'baja' : 'alta';

        if (!categoryId) {
            const candidatas = await this.candidatasDe(nombre, descripcion, vision, creds);
            // Las candidatas más cercanas al producto (por significado), sin las que Falabella ya rechazó: sirven de sugerencia.
            const masCercanas = (excepto?: string) => candidatas
                .filter((c) => !descartadas.includes(String(c.categoryId)) && String(c.categoryId) !== excepto)
                .slice(0, MAX_SUGERIDAS)
                .map((c) => ({ id: String(c.categoryId), path: c.name }));
            const r = await this.ai.elegirCategoriaVerificada('falabella', nombre, descripcion, candidatas, {
                vision,
                excluir: descartadas,
                buscarMas: (palabras) => this.canales.candidatasFalabella(creds, palabras),
            });
            if (r.id) {
                categoryId = r.id;
                ids.falabella_category_id = r.id;
                categoriaAuto = true;
                attrs._categoriaVerificada = r.id;
                confianza = r.confianza === 'alta' ? 'alta' : 'baja';
                if (confianza === 'alta') delete attrs._categoriaDudosa;
                else attrs._categoriaDudosa = { id: r.id, motivo: r.motivo ?? 'revisa que la categoría sea la correcta', options: masCercanas(r.id) };
            } else {
                // Mejor no publicar que publicar en la categoría equivocada; se muestran las más cercanas para que una persona elija.
                attrs._categoriaDudosa = { id: null, motivo: r.motivo ?? 'ninguna categoría encaja con el producto', options: masCercanas() };
            }
        }
        if (!categoryId) delete attrs.falabella_category_id;

        // Un producto con variantes se publica agrupado si la categoría lo admite: si la elegida no admite variantes, se busca una
        // parecida y verificada que sí; si no hay ninguna razonable, cada variante saldrá como ficha suelta con la variante en el nombre.
        // Una categoría que eligió una persona no se toca.
        if (categoryId && confianza !== 'manual' && (await this.sync.familiaDe(scope, productId)).length > 1
            && !(await this.admiteVariantes(scope, String(categoryId), connection.id))) {
            const alternativa = await this.categoriaQueAdmiteVariantes(scope, connection.id, creds, [...descartadas, String(categoryId)], nombre, descripcion, vision);
            if (alternativa) {
                this.logger.log(`Categoría de Falabella para ${product.sku}: ${categoryId} no admite variantes; se usa ${alternativa.id} (${alternativa.path}).`);
                categoryId = alternativa.id;
                ids.falabella_category_id = alternativa.id;
                attrs._categoriaVerificada = alternativa.id;
                categoriaAuto = true;
                confianza = 'alta';
                delete attrs._categoriaDudosa;
            }
        }

        // ── Marca: Falabella solo acepta las de su catálogo ──
        const original = String(attrs.brand ?? '').trim();
        let marca = original;
        let reemplazada = false;
        const indice = await this.falabella.brandsIndex(creds).catch(() => null);
        if (indice) {
            const canonica = indice.get(normalizar(original));
            if (canonica) marca = canonica;
            else if (normalizar(original) !== 'generico') {
                marca = 'GENERICO';
                reemplazada = !!original;
            }
        } else if (!marca) {
            marca = 'GENERICO';
        }
        attrs.brand = marca || 'GENERICO';

        // ── Medidas del paquete ──
        if ([product.packageWidth, product.packageLength, product.packageHeight, product.packageWeight].some((v) => v == null)) {
            const paquete = await this.ai.estimarPaquete(`${product.name}. ${product.description ?? ''}`, nombre, vision);
            if (paquete) {
                product.packageWidth ??= paquete.width;
                product.packageLength ??= paquete.length;
                product.packageHeight ??= paquete.height;
                product.packageWeight ??= paquete.weight;
                estimated.measures = true;
            }
        }

        // ── Datos obligatorios de la categoría ──
        let estimadosAhora: string[] = [];
        let totalAtributos = 0;
        let llenos = 0;
        if (categoryId) {
            // Todos los atributos de la categoría: los obligatorios y los que suben la calidad del contenido.
            const requisitos = await this.canales.requisitos('falabella', String(categoryId), undefined, { titulo: nombre, palabras: [] }, creds, { todos: true });
            const faltantes = (requisitos ?? []).filter((a) => {
                const v = this.sync.buscarAtributo(attrs, a.name);
                return v === null || v === undefined || String(v).trim() === '';
            });
            if (faltantes.length) {
                const r = await this.ai.completarAtributos(nombre, descripcion, faltantes, { marca: attrs.brand, color: attrs.color }, this.contextoDe(product, attrs, vision));
                attrs = { ...attrs, ...r.values };
                estimadosAhora = r.estimated;
                estimated.attributes.falabella = [...new Set([...(estimated.attributes.falabella ?? []), ...r.estimated])];
            }
            totalAtributos = (requisitos ?? []).length;
            llenos = (requisitos ?? []).filter((a) => {
                const v = this.sync.buscarAtributo(attrs, a.name);
                return v !== null && v !== undefined && String(v).trim() !== '';
            }).length;
        }

        // ── Descripción HTML estándar de la agencia ──
        // Va al final: así la redacción ya cuenta con la marca verificada, las medidas y los atributos que se acaban de completar.
        // Usa lo que escribió el cliente, el texto que ya tenga el producto, los atributos, lo que muestran las fotos y los GIFs
        // o imágenes cuyos enlaces pegó en el nombre o la descripción.
        let descripcionGenerada = false;
        if (opciones.regenerar) delete attrs.descriptionHtml;
        if (!attrs.descriptionHtml) {
            const ficha = await this.ai.generarDescripcionHtml({
                nombre,
                textoCliente: this.textoConocido(product),
                vision,
                atributos: attrs,
                imagenesDelProducto: (product.images ?? []).map((i) => i.url).filter(Boolean),
                urlsDelCliente: extraerUrlsDeImagen(`${product.name} ${product.description ?? ''}`),
            });
            if (ficha) {
                attrs.descriptionHtml = ficha.html;
                descripcionGenerada = true;
                // La descripción en texto (Mercado Libre y canales sin HTML) sale del mismo contenido: se redacta si el producto no tiene
                // una (la que trajo un canal o escribió una persona no se pisa) o si la persona pidió volver a redactar.
                if (ficha.texto && (opciones.regenerar || !String(product.aiDescription ?? '').trim())) product.aiDescription = ficha.texto;
                // Un título de 20 a 100 caracteres: Falabella baja la calidad de los más largos.
                if (opciones.regenerar || !product.aiTitle || product.aiTitle.length > 100) product.aiTitle = this.sync.nombreParaFalabella(ficha.title);
            }
        }

        product.marketplaceIds = ids as any;
        product.aiAttributes = { ...attrs, estimated };
        await this.products.save(product);

        // ── ¿Ya puede salir? Con las mismas reglas de la publicación real ──
        const atributosCategoria = categoryId ? await this.falabella.getCategoryAttributes(creds, categoryId).catch(() => []) : [];
        const validacion = this.sync.toFalabellaInput(product, 'active', atributosCategoria);
        const path = categoryId
            ? (await this.falabella.getCategories(creds).catch((): { id: string; path: string }[] => [])).find((c) => c.id === String(categoryId))?.path ?? `Categoría ${categoryId}`
            : null;

        const sinCategoria = !categoryId;
        return {
            sku: product.sku,
            listo: !('reason' in validacion),
            motivo: sinCategoria
                ? `no se encontró una categoría de Falabella que encaje con este producto (${attrs._categoriaDudosa?.motivo ?? 'sin candidatas'}). Elígela en la Ficha`
                : 'reason' in validacion ? validacion.reason : undefined,
            category: categoryId ? { id: String(categoryId), path: path!, auto: categoriaAuto, confidence: confianza ?? 'alta' } : null,
            ...(attrs._categoriaDudosa ? { categoryNote: String(attrs._categoriaDudosa.motivo) } : {}),
            ...(attrs._categoriaDudosa?.options?.length ? { categoryOptions: attrs._categoriaDudosa.options as { id: string; path: string }[] } : {}),
            brand: { value: attrs.brand, replaced: reemplazada, ...(reemplazada ? { original } : {}) },
            measures: {
                width: product.packageWidth, length: product.packageLength, height: product.packageHeight, weight: product.packageWeight,
                estimated: estimated.measures,
            },
            estimatedAttributes: (estimated.attributes.falabella ?? estimadosAhora).filter((n) => !sistema.has(claveDeAtributo(n))),
            descriptionGenerated: descripcionGenerada,
            attributes: { filled: llenos, total: totalAtributos },
        };
    }

    onModuleInit() {
        // Cuando la página pública de Falabella no da los ejes de una familia de variantes, la IA los propone (y se comprueban).
        this.sync.proponerEjesConIA = (fichas) => this.ai.proponerEjesDeVariacion(fichas);
        this.sync.alAprobarseUnaFicha = async (product) => {
            const categoria = this.sync.categoriaFalabella(product);
            if (!categoria) return;
            const vision = ((product.aiAttributes as any)?.vision as ProductVision | undefined) ?? null;
            await this.canales.confirmarCategoria('falabella', String(categoria), {
                titulo: product.aiTitle || product.name,
                palabras: [vision?.productType ?? '', ...(vision?.keywords ?? [])].filter(Boolean),
            });
        };
    }

    /**
     * Lo que ya se sabe del producto en texto: lo que escribió el cliente (sin enlaces) y la descripción en texto que tenga
     * guardada (la que redactó la IA o la que trajo un canal). Si una contiene a la otra no se repite.
     */
    private textoConocido(product: any): string {
        const propio = quitarUrls(product.description);
        const guardado = quitarUrls(product.aiDescription);
        const texto = !guardado ? propio
            : (!propio || guardado.includes(propio)) ? guardado
            : propio.includes(guardado) ? propio
            : `${propio}\n\n${guardado}`;
        return texto.slice(0, 4000);
    }

    /** Todo lo que se sabe del producto, para que la IA llene los atributos con la mayor información posible. */
    private contextoDe(product: any, attrs: Record<string, any>, vision: any) {
        const medidas = [product.packageWidth, product.packageLength, product.packageHeight].every((v) => v != null)
            ? `${product.packageWidth} x ${product.packageLength} x ${product.packageHeight} cm, ${product.packageWeight ?? '?'} kg`
            : undefined;
        return { textoCliente: this.textoConocido(product), vision, medidas, sku: product.sku };
    }

    /**
     * Valores sugeridos para TODOS los atributos de una categoría de Falabella, sin guardar nada. Sirve al elegir
     * o cambiar la categoría: los campos aparecen ya llenos con lo que se pudo sacar del producto.
     */
    async sugerirAtributos(scope: SyncScope, productId: string, categoryId: string, connectionId?: string) {
        const product = await this.sync.findScopedProduct(scope, productId);
        const connection = await this.sync.resolveConnection(scope.storeId, 'falabella', connectionId);
        const creds = this.sync.credentialsOf(connection);
        const attrs: Record<string, any> = { ...((product.aiAttributes as any) || {}) };
        const vision = (attrs.vision as ProductVision | undefined) ?? null;

        const definiciones = (await this.falabella.getCategoryAttributes(creds, categoryId)).filter((a) => !esAtributoDeSistema(a));
        const actuales: Record<string, string> = {};
        const faltantes = [] as { name: string; description: string; example: string; isRequired: boolean; options?: string[] }[];
        for (const a of definiciones) {
            const v = this.sync.buscarAtributo(attrs, a.name);
            if (v !== null && v !== undefined && String(v).trim() !== '') {
                actuales[a.name] = String(v);
                continue;
            }
            faltantes.push({
                name: a.name,
                description: [a.label || a.name, a.description].filter(Boolean).join(' — '),
                example: a.options?.[0] ?? '',
                isRequired: a.isMandatory,
                ...(a.options?.length ? { options: a.options } : {}),
            });
        }

        const r = await this.ai.completarAtributos(
            product.aiTitle || product.name,
            product.aiDescription || product.description || product.name,
            faltantes.slice(0, 80),
            { marca: attrs.brand, color: attrs.color },
            this.contextoDe(product, attrs, vision),
        );
        return { values: { ...actuales, ...r.values }, estimated: r.estimated, filled: Object.keys(r.values).length, total: definiciones.length };
    }

    /**
     * Pone al día una ficha que ya está en Falabella, en dos acciones separadas para que la persona vea lo que
     * generó la IA antes de que llegue al canal (lo que el canal ya tenía puede ser información precisa):
     *  - por defecto solo PREPARA: vuelve a completar lo que falte (atributos, medidas, descripción) y lo guarda en
     *    Synkro, sin enviar nada. Con `regenerar` la IA vuelve a redactar el nombre y la descripción.
     *  - con `enviar` manda a Falabella el nombre, la descripción, la marca y los atributos que tenga el producto
     *    ahora, sin pasar otra vez por la IA: sale exactamente lo que la persona revisó.
     */
    async actualizarEnFalabella(scope: SyncScope, productId: string, opciones: { regenerar?: boolean; connectionId?: string; enviar?: boolean } = {}) {
        if (opciones.enviar) {
            const envio = await this.sync.updateFalabellaContent(scope, productId, opciones.connectionId);
            return { ...envio, sent: true as const };
        }
        const reporte = await this.preparar(scope, productId, opciones.connectionId, { regenerar: opciones.regenerar });
        return {
            message: 'Listo en Synkro: no se envió nada a Falabella. Revisa la ficha del producto y, si está bien, pulsa «Enviar a Falabella».',
            sent: false as const,
            report: reporte,
        };
    }
}
