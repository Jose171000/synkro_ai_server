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
import { ProductVision } from './product-vision.service';
import { ATRIBUTOS_DE_SISTEMA, claveDeAtributo } from '../sync/falabella/falabella-fields';
import { extraerUrlsDeImagen, quitarUrls } from './description-html';

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
    ) { }

    async preparar(scope: SyncScope, productId: string, connectionId?: string, opciones: { regenerar?: boolean } = {}): Promise<FalabellaPrepReport> {
        const product = await this.sync.findScopedProduct(scope, productId);
        const connection = await this.sync.resolveConnection(scope.storeId, 'falabella', connectionId);
        const creds = this.sync.credentialsOf(connection);

        let attrs: Record<string, any> = { ...((product.aiAttributes as any) || {}) };
        const ids: Record<string, any> = { ...((product.marketplaceIds as any) || {}) };
        const nombre = product.aiTitle || product.name;
        const descripcion = product.aiDescription || product.description || nombre;
        const vision = (attrs.vision as ProductVision | undefined) ?? null;
        const estimated = { measures: !!attrs.estimated?.measures, attributes: { ...(attrs.estimated?.attributes ?? {}) } as Record<string, string[]> };

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

        // ── Descripción HTML estándar de la agencia ──
        let descripcionGenerada = false;
        if (opciones.regenerar) delete attrs.descriptionHtml;
        if (!attrs.descriptionHtml) {
            const ficha = await this.ai.generarDescripcionHtml({
                nombre,
                textoCliente: quitarUrls(product.description),
                vision,
                atributos: attrs,
                imagenesDelProducto: (product.images ?? []).map((i) => i.url).filter(Boolean),
                urlsDelCliente: extraerUrlsDeImagen(`${product.name} ${product.description ?? ''}`),
            });
            if (ficha) {
                attrs.descriptionHtml = ficha.html;
                descripcionGenerada = true;
                // Un título de 20 a 100 caracteres: Falabella baja la calidad de los más largos.
                if (opciones.regenerar || !product.aiTitle || product.aiTitle.length > 100) product.aiTitle = this.sync.nombreParaFalabella(ficha.title);
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

    /** Todo lo que se sabe del producto, para que la IA llene los atributos con la mayor información posible. */
    private contextoDe(product: any, attrs: Record<string, any>, vision: any) {
        const medidas = [product.packageWidth, product.packageLength, product.packageHeight].every((v) => v != null)
            ? `${product.packageWidth} x ${product.packageLength} x ${product.packageHeight} cm, ${product.packageWeight ?? '?'} kg`
            : undefined;
        return { textoCliente: quitarUrls(product.description), vision, medidas, sku: product.sku };
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

        const definiciones = (await this.falabella.getCategoryAttributes(creds, categoryId)).filter((a) => !CUBIERTOS.has(a.name));
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
     * Pone al día una ficha que ya está en Falabella: vuelve a completar lo que falte (atributos, medidas,
     * descripción) y manda el nombre, la descripción, la marca y los atributos actuales. Con `regenerar`
     * la IA vuelve a redactar el nombre y la descripción a partir de lo que tenga hoy el producto.
     */
    async actualizarEnFalabella(scope: SyncScope, productId: string, opciones: { regenerar?: boolean; connectionId?: string } = {}) {
        const reporte = await this.preparar(scope, productId, opciones.connectionId, { regenerar: opciones.regenerar });
        const envio = await this.sync.updateFalabellaContent(scope, productId, opciones.connectionId);
        return { ...envio, report: reporte };
    }
}
