import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SyncScope, SyncService } from '../sync.service';
import { EcommerceSyncService } from '../channels/ecommerce-sync.service';
import { RipleyApiService } from './ripley-api.service';
import { RipleyCatalogoService } from './ripley-catalogo.service';
import { RipleyMarcasService } from './ripley-marcas.service';
import { skuPermitidoParaRipley } from './ripley-oferta';
import { armarCsv, columnasDeAtributos, filaDeRipley, MAX_NOMBRE, ProductoParaRipley, validarProductoParaRipley } from './ripley-publicacion';
import { ajustarAUnaLista } from '../../ai/ripley-atributos';
import { EjeSynkro, InfoVariantesDeCategoria, revisarCompatibilidad } from '../../products/compatibilidad-variantes';
import { etiquetaDe } from '../../products/variantes';
import { tituloDeVariante } from '../../products/titulos-de-variante';

/** El interruptor de la publicación: apagado por defecto. Aparte del de stock y precio (RIPLEY_PUSH_ENABLED). */
const publicacionEncendida = () => process.env.RIPLEY_PUBLISH_ENABLED === 'true';
/** Tope de productos por envío: un piloto o una familia, nunca el catálogo entero de golpe. */
const MAX_PRODUCTOS_POR_ENVIO = 50;

export interface VistaPreviaDeRipley {
    categoria: { id: string; ruta: string } | null;
    /** `sola`: producto sin variantes · `una`: variantes en UNA publicación · `separadas`: cada variante como producto aparte. */
    publicaComo: 'sola' | 'una' | 'separadas';
    avisosDeVariantes: string[];
    productos: { sku: string; nombre: string; precio: number | null; stock: number | null; errores: string[]; avisos: string[] }[];
    /** Problemas generales (sin categoría, demasiados productos…). */
    errores: string[];
    puedeEnviar: boolean;
    envioEncendido: boolean;
    skusNoPermitidos: string[];
    columnas: number;
    csv: string;
}

/**
 * Publica en Ripley (OF01) productos nuevos desde Synkro: arma el CSV con lo que el producto ya tiene guardado para Ripley,
 * lo valida ANTES de enviarlo y solo lo envía con interruptor encendido, SKU permitido y confirmación expresa.
 * Con variantes: las que caben en UNA publicación van con el mismo `variant_id`; las que no, como productos separados.
 */
@Injectable()
export class RipleyPublicacionService {
    private readonly logger = new Logger('RipleyPublicacion');

    constructor(
        private readonly sync: SyncService,
        private readonly ecommerce: EcommerceSyncService,
        private readonly ripley: RipleyApiService,
        private readonly catalogo: RipleyCatalogoService,
        private readonly marcas: RipleyMarcasService,
    ) { }

    /** Lo que se enviaría, con sus problemas y el CSV. NO envía nada ni escribe en ningún sitio. */
    async vistaPrevia(scope: SyncScope, productId: string, opciones: { alGrupo?: boolean } = {}): Promise<VistaPreviaDeRipley> {
        const base = { categoria: null, publicaComo: 'sola' as const, avisosDeVariantes: [] as string[], productos: [], puedeEnviar: false, envioEncendido: publicacionEncendida(), skusNoPermitidos: [] as string[], columnas: 0, csv: '' };
        const familia: any[] = opciones.alGrupo ? await this.sync.familiaDe(scope, productId) : [await this.sync.findScopedProduct(scope, productId)];
        const grupo = familia.length > 1 ? (familia[0] as any).group ?? null : null;

        if (familia.length > MAX_PRODUCTOS_POR_ENVIO) return { ...base, errores: [`Un envío admite hasta ${MAX_PRODUCTOS_POR_ENVIO} productos y este tiene ${familia.length}.`] };
        const ids = familia.map((p) => (p.marketplaceIds as any)?.ripley_category_id).find((x) => String(x ?? '').trim());
        if (!ids) return { ...base, errores: ['El producto no tiene categoría de Ripley: usa «Preparar para Ripley» y elige una.'] };
        const categoryId = String(ids);

        let campos;
        try { campos = await this.catalogo.campos(categoryId); }
        catch { return { ...base, errores: [`La categoría ${categoryId} no está en el catálogo de Ripley importado.`] }; }
        const ruta = campos.path;
        const camposValidacion = campos.campos.map((c) => ({ name: c.name, label: c.label, required: c.required, isVariant: c.isVariant }));

        // ¿Las variantes caben en UNA publicación? Se compara con lo que admite la categoría (el mismo cálculo del aviso de la app).
        let publicaComo: 'sola' | 'una' | 'separadas' = 'sola';
        let avisosDeVariantes: string[] = [];
        let mapeo: { eje: string; atributo: string }[] = [];
        const ejes: EjeSynkro[] = grupo?.axes ?? [];
        if (grupo) {
            const ejesDeCanal: InfoVariantesDeCategoria['ejes'] = [];
            for (const c of campos.campos.filter((x) => x.isVariant)) {
                const options = c.options ?? (c.listCode ? await this.catalogo.listaCompleta(c.listCode) : undefined);
                ejesDeCanal.push({ id: c.name, label: c.label, required: c.required, ...(options?.length ? { options } : {}) });
            }
            const info: InfoVariantesDeCategoria = { canal: 'ripley', categoryId, ruta, admite: ejesDeCanal.length > 0, ejes: ejesDeCanal };
            const r = revisarCompatibilidad(ejes, info);
            publicaComo = r.publicaComo;
            avisosDeVariantes = r.avisos;
            mapeo = r.mapeo;
        }

        const productos: VistaPreviaDeRipley['productos'] = [];
        const filas: Record<string, string>[] = [];
        const atributosDeColumna = columnasDeAtributos(campos.campos);
        for (const p of familia) {
            const attrs = ((p.aiAttributes as any) || {}) as Record<string, any>;
            const atributos: Record<string, string> = Object.fromEntries(Object.entries(attrs.ripley_attributes ?? {}).map(([k, v]) => [k, String(v)]));
            // El color y la talla de cada variante salen de SUS valores, llevados a la escritura exacta de las listas de Ripley.
            for (const par of mapeo) {
                const valor = p.variantValues?.[par.eje];
                const campo = campos.campos.find((c) => c.name === par.atributo);
                const lista = campo?.options ?? (campo?.listCode ? await this.catalogo.listaCompleta(campo.listCode) : undefined);
                const ajustado = valor && lista?.length ? ajustarAUnaLista(valor, lista) : (valor ?? null);
                if (ajustado) atributos[par.atributo] = ajustado; else delete atributos[par.atributo];
            }

            const baseNombre = String(attrs.ripley?.name ?? '').trim();
            const nombre = grupo && publicaComo === 'separadas' && baseNombre
                ? (tituloDeVariante(baseNombre, etiquetaDe(p.variantValues ?? {}, ejes as any), ejes.flatMap((e) => e.values), MAX_NOMBRE) ?? baseNombre)
                : baseNombre;
            const marcaEscrita = String(attrs.ripley?.brand ?? attrs.brand ?? 'GENÉRICO').trim();
            const marca = await this.marcas.revisar(marcaEscrita);
            const imagenes = [...(p.images ?? [])].sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0)).map((i: any) => i.url).filter(Boolean);
            const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

            const producto: ProductoParaRipley = {
                sku: p.sku,
                categoria: { id: categoryId, ruta },
                nombre,
                descripcionCorta: String(attrs.ripley?.shortDescription ?? '').trim(),
                // La descripción completa es la ficha HTML general del producto (Ripley la acepta); el texto de Ripley es el respaldo.
                descripcion: String(attrs.descriptionHtml ?? attrs.ripley?.description ?? p.aiDescription ?? p.description ?? '').trim(),
                marca: marca.canonica ?? marcaEscrita,
                marcaValida: marca.valida,
                imagenes,
                precio: num(p.price),
                stock: num(p.stock),
                paquete: { largo: num(p.packageLength), ancho: num(p.packageWidth), alto: num(p.packageHeight), peso: num(p.packageWeight) },
                atributos,
                varianteDe: grupo && publicaComo === 'una' ? String(grupo.parentSku ?? '') || null : null,
            };
            const problemas = validarProductoParaRipley(producto, camposValidacion);
            productos.push({ sku: p.sku, nombre: producto.nombre.toLocaleUpperCase('es'), precio: producto.precio, stock: producto.stock, ...problemas });
            filas.push(filaDeRipley(producto, atributosDeColumna));
        }

        const { csv, columnas } = armarCsv(filas, atributosDeColumna);
        // La lista de publicación es SU PROPIA variable: sin ella no se permite ninguno. Se pasa '' y no `undefined`, porque con `undefined`
        // la función tomaría por defecto la lista del envío de stock (RIPLEY_PUSH_SKUS, que puede ser «*») y abriría la publicación a todos.
        const skusNoPermitidos = familia.map((p) => p.sku).filter((sku) => !skuPermitidoParaRipley(sku, process.env.RIPLEY_PUBLISH_SKUS ?? ''));
        return {
            categoria: { id: categoryId, ruta },
            publicaComo: grupo ? publicaComo : 'sola',
            avisosDeVariantes,
            productos,
            errores: [],
            puedeEnviar: productos.every((x) => x.errores.length === 0),
            envioEncendido: publicacionEncendida(),
            skusNoPermitidos,
            columnas: columnas.length,
            csv,
        };
    }

    /**
     * ENVÍA el producto a Ripley (crea su ficha y su oferta). Escribe en el catálogo REAL de la tienda, así que exige las cuatro
     * cosas a la vez: confirmación expresa, interruptor RIPLEY_PUBLISH_ENABLED encendido, SKU en RIPLEY_PUBLISH_SKUS y cero errores.
     */
    async publicar(scope: SyncScope, productId: string, opciones: { alGrupo?: boolean; confirmar?: boolean; connectionId?: string }) {
        if (opciones.confirmar !== true) throw new BadRequestException('Falta la confirmación expresa para enviar a Ripley.');
        const vista = await this.vistaPrevia(scope, productId, { alGrupo: opciones.alGrupo });
        if (!vista.envioEncendido) throw new BadRequestException('La publicación en Ripley está apagada en el servidor (RIPLEY_PUBLISH_ENABLED). Revisa el envío con la vista previa; para enviar hay que encenderla.');
        if (vista.errores.length) throw new BadRequestException(vista.errores.join(' '));
        if (vista.skusNoPermitidos.length) throw new BadRequestException(`Estos SKU no están en la lista de publicación permitida (RIPLEY_PUBLISH_SKUS): ${vista.skusNoPermitidos.join(', ')}.`);
        if (!vista.puedeEnviar) {
            const primeros = vista.productos.flatMap((p) => p.errores.map((e) => `${p.sku}: ${e}`)).slice(0, 5);
            throw new BadRequestException(`Hay datos por corregir antes de enviar. ${primeros.join(' · ')}`);
        }
        const conexion = await this.sync.resolveConnection(scope.storeId, 'ripley', opciones.connectionId);
        const r = await this.ripley.importarProductosYOfertas(this.ecommerce.authOf(conexion), vista.csv);
        this.logger.log(`Ripley: se enviaron ${vista.productos.length} producto(s) (${vista.productos.map((p) => p.sku).join(', ')}) → importación ${r.importId}.`);
        return { ...r, enviados: vista.productos.map((p) => p.sku), publicaComo: vista.publicaComo };
    }

    /** Cómo va lo enviado: la importación de ofertas (OF02) y la de productos (P42), con los errores si los hay. Solo consulta. */
    async estado(scope: SyncScope, importId: string, productImportId?: string, connectionId?: string) {
        const auth = this.ecommerce.authOf(await this.sync.resolveConnection(scope.storeId, 'ripley', connectionId));
        const ofertas = await this.ripley.estadoDeImportacion(auth, importId);
        const productos = productImportId ? await this.ripley.estadoDeProductos(auth, productImportId).catch(() => null) : null;
        const erroresDeOfertas = Number(ofertas?.lines_in_error) > 0 || ofertas?.status === 'FAILED' ? await this.ripley.reporteDeErrores(auth, 'ofertas', importId) : [];
        const erroresDeProductos = productos && (Number(productos?.lines_in_error ?? productos?.transform_lines_in_error) > 0 || productos?.has_transformation_error_report === true)
            ? await this.ripley.reporteDeErrores(auth, 'productos', productImportId!) : [];
        const terminado = (s?: string) => ['COMPLETE', 'FAILED', 'CANCELLED'].includes(String(s ?? '').toUpperCase());
        const enCurso = !terminado(ofertas?.status) || (productos ? !terminado(productos?.import_status ?? productos?.status) : false);
        const hayErrores = erroresDeOfertas.length > 0 || erroresDeProductos.length > 0 || String(ofertas?.status).toUpperCase() === 'FAILED';
        return {
            resumen: enCurso ? 'en-curso' : hayErrores ? 'con-errores' : 'listo',
            ofertas: { estado: ofertas?.status ?? null, leidas: ofertas?.lines_read ?? null, correctas: ofertas?.lines_in_success ?? null, conError: ofertas?.lines_in_error ?? null },
            productos: productos ? { estado: productos?.import_status ?? productos?.status ?? null, leidas: productos?.transform_lines_read ?? null, correctas: productos?.transform_lines_in_success ?? null, conError: productos?.transform_lines_in_error ?? null } : null,
            errores: { ofertas: erroresDeOfertas, productos: erroresDeProductos },
        };
    }
}
