import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { ProductImage } from './entities/product-image.entity';
import { EjeDeVariacion, ProductGroup } from './entities/product-group.entity';
import { ProductsService } from './products.service';
import { AiService } from '../ai/ai.service';
import { DeteccionDeVariantes, ProductVisionService } from '../ai/product-vision.service';
import {
    asignarSkus, claveDeCombinacion, etiquetaDe, MAX_VARIANTES, normalizar, normalizarEjes, valoresDeVariante, ValoresDeVariante,
} from './variantes';

/** Quién actúa y en qué tienda. */
export interface AmbitoDeGrupo {
    userId: string;
    storeId: string;
}

export interface VarianteEntrada {
    values: Record<string, string>;
    sku?: string | null;
    price?: number | null;
    stock?: number | null;
    images?: string[];
}

export interface CrearGrupoEntrada {
    /** Código del grupo (en Falabella es el ParentSku). */
    parentSku: string;
    /** Sin nombre, se usa el código mientras tanto y la IA lo reemplaza desde las fotos. */
    name?: string;
    description?: string;
    category?: string;
    subCategory?: string;
    targetMarketplaces?: string[];
    /** Genera con IA, una sola vez para todo el grupo, los datos que el cliente no escribió. */
    generateWithAi?: boolean;
    axes: { name: string; values: string[] }[];
    variants: VarianteEntrada[];
}

export interface AgregarVariantesEntrada {
    /** Solo al convertir un producto simple en grupo: los ejes completos (con el valor del producto actual incluido). */
    axes?: { name: string; values: string[] }[];
    /** Solo al convertir: qué variante es el producto que ya existe (ej. {Color:'Rojo', Talla:'M'}). */
    thisVariant?: Record<string, string>;
    variants: VarianteEntrada[];
}

export interface VistaDeGrupo {
    /** Resultado de la generación con IA, si se pidió. Un fallo no impide que el grupo quede creado. */
    ia?: { ok: boolean; motivo?: string };
    id: string;
    name: string;
    parentSku: string;
    axes: EjeDeVariacion[];
    variants: {
        id: string;
        sku: string;
        name: string;
        price: number | null;
        stock: number;
        variantValues: ValoresDeVariante | null;
        images: string[];
    }[];
}

/**
 * Crea y amplía productos con variantes. Cada variante es un producto (con su SKU único en la tienda, precio, stock y
 * fotos) enlazado a un grupo; todo se guarda en una transacción, así un fallo a medias no deja variantes sueltas.
 */
@Injectable()
export class ProductGroupsService {
    constructor(
        @InjectRepository(Product) private readonly productRepository: Repository<Product>,
        @InjectRepository(ProductGroup) private readonly groupRepository: Repository<ProductGroup>,
        private readonly dataSource: DataSource,
        private readonly products: ProductsService,
        private readonly ai: AiService,
        private readonly vision: ProductVisionService,
    ) { }

    // ─────────────────────────────────────────────────────────────
    // Crear un grupo con sus variantes
    // ─────────────────────────────────────────────────────────────

    async crear(entrada: CrearGrupoEntrada, ambito: AmbitoDeGrupo): Promise<VistaDeGrupo> {
        const parentSku = String(entrada?.parentSku ?? '').trim();
        if (!parentSku) throw new BadRequestException('Falta el código del grupo.');
        const name = String(entrada?.name ?? '').trim() || parentSku;

        const ejes = normalizarEjes(entrada.axes);
        const variantes = this.variantesValidas(entrada.variants, ejes);
        await this.codigoDeGrupoLibre(parentSku, ambito);
        const skus = await this.resolverSkus(parentSku, variantes, ejes, ambito);

        const grupoId = await this.dataSource.transaction(async (manager) => {
            const grupo = await this.guardar(manager, manager.create(ProductGroup, {
                name, parentSku, axes: ejes, owner: { id: ambito.userId } as any, store: { id: ambito.storeId } as any,
            }), parentSku);
            for (let i = 0; i < variantes.length; i++) {
                await this.guardarVariante(manager, grupo, variantes[i], skus[i], ejes, {
                    name, description: entrada.description, category: entrada.category,
                    subCategory: entrada.subCategory, targetMarketplaces: entrada.targetMarketplaces,
                }, ambito);
            }
            return grupo.id;
        });
        const vista = await this.obtener(grupoId, ambito);
        if (entrada.generateWithAi) vista.ia = await this.generarContenido(grupoId, { ...entrada, name }, ambito, vista, { sinNombre: !String(entrada?.name ?? '').trim(), sinDescripcion: !String(entrada?.description ?? '').trim() });
        return vista.ia ? { ...(await this.obtener(grupoId, ambito)), ia: vista.ia } : vista;
    }

    /** Filtro previo: ¿las fotos y el texto indican que el producto tiene variantes? Devuelve null si no se pudo comprobar. */
    async detectar(imageUrls: string[], texto?: string): Promise<DeteccionDeVariantes | null> {
        return this.vision.detectarVariantes(imageUrls ?? [], texto);
    }

    /**
     * Genera una sola vez, con IA, el contenido del grupo (categoría, descripción, atributos, medidas) y lo reparte entre
     * todas las variantes: cada una conserva su título con su combinación y recibe sus valores como atributos (Color, Talla…).
     * Si la IA falla, las variantes quedan creadas igual y se avisa.
     */
    private async generarContenido(
        grupoId: string,
        entrada: CrearGrupoEntrada,
        ambito: AmbitoDeGrupo,
        vista: VistaDeGrupo,
        faltaba: { sinNombre: boolean; sinDescripcion: boolean },
    ): Promise<{ ok: boolean; motivo?: string }> {
        try {
            const variantes = await this.productRepository.find({ where: { group: { id: grupoId } }, order: { createdAt: 'ASC' } });
            // Una foto de cada variante primero (así la IA ve todos los colores), y luego las demás.
            const primeras = variantes.map((v) => v.images?.[0]?.url).filter(Boolean) as string[];
            const resto = variantes.flatMap((v) => (v.images ?? []).slice(1).map((i) => i.url));
            const urls = [...new Set([...primeras, ...resto])].slice(0, 4);

            const contenido = await this.ai.generateProductContent({
                // Sin nombre escrito la IA parte de las fotos, no del código usado mientras tanto.
                name: faltaba.sinNombre ? '' : String(entrada.name ?? ''),
                description: entrada.description ?? '',
                category: entrada.category,
                subcategory: entrada.subCategory,
                targetMarketplaces: entrada.targetMarketplaces?.length ? entrada.targetMarketplaces : ['mercadolibre', 'falabella'],
                imageUrls: urls,
                userId: ambito.userId,
            });

            const molde: any = { aiAttributes: {}, marketplaceIds: {}, aiTitle: undefined, aiDescription: undefined, aiKeywords: undefined };
            this.products.applyAiContent(molde, contenido);

            // Sin nombre escrito, el del grupo y el de cada variante pasan a ser el que armó la IA.
            const nombreDeLaIa = faltaba.sinNombre ? String(molde.aiTitle || (contenido as any)?.vision?.suggestedName || '').trim().slice(0, 150) : '';
            if (nombreDeLaIa) await this.groupRepository.update(grupoId, { name: nombreDeLaIa } as any);

            for (const variante of variantes) {
                const etiqueta = etiquetaDe(variante.variantValues ?? {}, vista.axes);
                if (nombreDeLaIa) variante.name = `${nombreDeLaIa} - ${etiqueta}`.slice(0, 250);
                if (faltaba.sinDescripcion && molde.aiDescription) variante.description = molde.aiDescription;
                variante.aiTitle = this.tituloDeVariante(molde.aiTitle, etiqueta) as any;
                variante.aiDescription = molde.aiDescription;
                variante.aiKeywords = molde.aiKeywords;
                variante.marketplaceIds = { ...(molde.marketplaceIds ?? {}) };
                // Cada variante lleva sus propios valores como atributos (Color: Rojo, Talla: M) y lo común del grupo.
                variante.aiAttributes = { ...(molde.aiAttributes ?? {}), ...(variante.variantValues ?? {}) };
                if (molde.packageWidth != null) {
                    variante.packageWidth = molde.packageWidth; variante.packageLength = molde.packageLength;
                    variante.packageHeight = molde.packageHeight; variante.packageWeight = molde.packageWeight;
                }
                variante.status = 'synced';
                await this.productRepository.save(variante);
            }
            return { ok: true };
        } catch (error: any) {
            return { ok: false, motivo: String(error?.response?.message ?? error?.message ?? 'La IA no pudo generar el contenido') };
        }
    }

    /** Título de la variante: el del grupo más su combinación, sin pasar de 60 caracteres (el límite más estricto de los canales). */
    private tituloDeVariante(base: string | undefined, etiqueta: string): string | undefined {
        if (!base) return undefined;
        const sufijo = ` - ${etiqueta}`;
        return `${base.slice(0, Math.max(10, 60 - sufijo.length)).trim()}${sufijo}`.slice(0, 60);
    }

    // ─────────────────────────────────────────────────────────────
    // Agregar variantes a un producto que ya existe
    // ─────────────────────────────────────────────────────────────

    /**
     * Agrega variantes a un producto ya creado. Si el producto es simple, se convierte en grupo: conserva su SKU, su
     * stock, sus fotos y sus enlaces a los canales, y pasa a ser la primera variante (su SKU es el código del grupo).
     * Si ya pertenece a un grupo, las variantes se suman a ese grupo; los valores nuevos de un eje se añaden solos, pero
     * no se pueden añadir ejes nuevos.
     */
    async agregarVariantes(productoId: string, entrada: AgregarVariantesEntrada, ambito: AmbitoDeGrupo): Promise<VistaDeGrupo> {
        const producto = await this.productoDelAmbito(productoId, ambito);
        if (!Array.isArray(entrada?.variants) || !entrada.variants.length) throw new BadRequestException('Indica al menos una variante nueva.');

        let grupo: ProductGroup | null = null;
        let ejes: EjeDeVariacion[];
        let existentes: Product[] = [];
        let valoresDelActual: ValoresDeVariante | null = null;

        if (producto.group) {
            grupo = await this.groupRepository.findOne({ where: { id: producto.group.id }, relations: { store: true, owner: true } });
            if (!grupo) throw new NotFoundException('Grupo no encontrado');
            existentes = await this.productRepository.find({ where: { group: { id: grupo.id } } });
            ejes = this.ampliarEjes(grupo.axes, entrada.variants);
        } else {
            ejes = normalizarEjes(entrada.axes);
            if (!entrada.thisVariant) throw new BadRequestException('Indica qué variante es el producto que ya tienes (por ejemplo, Color: Rojo, Talla: M).');
            valoresDelActual = valoresDeVariante(entrada.thisVariant, ejes);
        }

        const nuevas = this.variantesValidas(entrada.variants, ejes);
        const claves = new Set<string>(existentes.map((p) => claveDeCombinacion(p.variantValues ?? {}, ejes)));
        if (valoresDelActual) claves.add(claveDeCombinacion(valoresDelActual, ejes));
        for (const v of nuevas) {
            if (claves.has(claveDeCombinacion(v.valores, ejes))) {
                throw new ConflictException(`Ya existe la variante ${etiquetaDe(v.valores, ejes)} en este producto.`);
            }
        }
        if (existentes.length + nuevas.length + (valoresDelActual ? 1 : 0) > MAX_VARIANTES) {
            throw new BadRequestException(`Un producto admite hasta ${MAX_VARIANTES} variantes.`);
        }

        const codigo = grupo?.parentSku ?? producto.sku;
        const skus = await this.resolverSkus(codigo, nuevas, ejes, ambito);

        const grupoId = await this.dataSource.transaction(async (manager) => {
            let g = grupo;
            if (!g) {
                g = await this.guardar(manager, manager.create(ProductGroup, {
                    name: producto.name, parentSku: producto.sku, axes: ejes,
                    owner: { id: ambito.userId } as any, store: { id: ambito.storeId } as any,
                }), producto.sku);
                // El producto pasa a ser la primera variante; si aún no tenía tienda, la toma ahora.
                try {
                    await manager.update(Product, producto.id, { group: { id: g.id }, variantValues: valoresDelActual, ...(producto.store ? {} : { store: { id: ambito.storeId } }) } as any);
                } catch (error: any) {
                    if (error?.code === '23505') throw new ConflictException(`Ya existe otro producto con el SKU "${producto.sku}" en esta tienda.`);
                    throw error;
                }
            } else if (JSON.stringify(g.axes) !== JSON.stringify(ejes)) {
                await manager.update(ProductGroup, g.id, { axes: ejes } as any);
            }
            for (let i = 0; i < nuevas.length; i++) {
                await this.guardarVariante(manager, g, nuevas[i], skus[i], ejes, {
                    name: g.name, description: producto.description, category: producto.category,
                    subCategory: producto.subCategory, targetMarketplaces: producto.targetMarketplaces,
                }, ambito);
            }
            return g.id;
        });
        return this.obtener(grupoId, ambito);
    }

    // ─────────────────────────────────────────────────────────────
    // Consultar un grupo
    // ─────────────────────────────────────────────────────────────

    async obtener(grupoId: string, ambito: AmbitoDeGrupo): Promise<VistaDeGrupo> {
        const grupo = await this.groupRepository.findOne({ where: { id: grupoId }, relations: { store: true, owner: true } });
        const esDeLaTienda = !!grupo && (grupo.store?.id === ambito.storeId || (!grupo.store && grupo.owner?.id === ambito.userId));
        if (!grupo || !esDeLaTienda) throw new NotFoundException('Grupo no encontrado');

        const variantes = await this.productRepository.find({ where: { group: { id: grupo.id } }, order: { createdAt: 'ASC' } });
        return {
            id: grupo.id,
            name: grupo.name,
            parentSku: grupo.parentSku,
            axes: grupo.axes,
            variants: variantes.map((p) => ({
                id: p.id,
                sku: p.sku,
                name: p.name,
                price: p.price != null ? Number(p.price) : null,
                stock: p.stock,
                variantValues: p.variantValues ?? null,
                images: (p.images ?? []).map((i) => i.url),
            })),
        };
    }

    // ─────────────────────────────────────────────────────────────
    // Piezas internas
    // ─────────────────────────────────────────────────────────────

    /** Valida las variantes de la entrada contra los ejes y que no repitan combinación entre sí. */
    private variantesValidas(entrada: unknown, ejes: EjeDeVariacion[]): { valores: ValoresDeVariante; original: VarianteEntrada }[] {
        if (!Array.isArray(entrada) || !entrada.length) throw new BadRequestException('Indica al menos una variante.');
        if (entrada.length > MAX_VARIANTES) throw new BadRequestException(`Un producto admite hasta ${MAX_VARIANTES} variantes.`);
        const vistas = new Set<string>();
        return entrada.map((v: VarianteEntrada) => {
            const valores = valoresDeVariante(v?.values, ejes);
            const clave = claveDeCombinacion(valores, ejes);
            if (vistas.has(clave)) throw new BadRequestException(`La variante ${etiquetaDe(valores, ejes)} está repetida.`);
            vistas.add(clave);
            if (v?.price != null && !(Number(v.price) >= 0)) throw new BadRequestException(`El precio de ${etiquetaDe(valores, ejes)} no es válido.`);
            if (v?.stock != null && !(Number.isInteger(Number(v.stock)) && Number(v.stock) >= 0)) throw new BadRequestException(`El stock de ${etiquetaDe(valores, ejes)} debe ser un entero.`);
            return { valores, original: v };
        });
    }

    /** Si una variante usa un valor que el eje aún no tiene (en un grupo existente), el eje lo incorpora. */
    private ampliarEjes(actuales: EjeDeVariacion[], variantes: VarianteEntrada[]): EjeDeVariacion[] {
        const ejes = actuales.map((e) => ({ name: e.name, values: [...e.values] }));
        for (const v of variantes) {
            const origen = (v?.values ?? {}) as Record<string, unknown>;
            for (const eje of ejes) {
                const clave = Object.keys(origen).find((k) => normalizar(k) === normalizar(eje.name));
                const dado = clave !== undefined ? String(origen[clave] ?? '').trim() : '';
                if (dado && !eje.values.some((x) => normalizar(x) === normalizar(dado))) eje.values.push(dado);
            }
            const nombresConocidos = new Set(ejes.map((e) => normalizar(e.name)));
            for (const k of Object.keys(origen)) {
                if (!nombresConocidos.has(normalizar(k))) throw new BadRequestException(`El eje "${k}" no existe en este producto: no se pueden añadir ejes nuevos a un producto con variantes.`);
            }
        }
        return ejes;
    }

    /** El código del grupo no puede ser el SKU de otro producto de la tienda (Falabella los agruparía por error). */
    private async codigoDeGrupoLibre(parentSku: string, ambito: AmbitoDeGrupo): Promise<void> {
        const existentes = await this.products.skusExistentes({ userId: ambito.userId, storeId: ambito.storeId }, [parentSku]);
        if (existentes.has(parentSku.toLowerCase())) {
            throw new ConflictException(`El código "${parentSku}" ya es el SKU de otro producto de esta tienda. Elige otro código para el grupo.`);
        }
    }

    /** SKU de cada variante: los escritos se respetan, los demás se generan sin chocar con los de la tienda. */
    private async resolverSkus(
        codigo: string,
        variantes: { valores: ValoresDeVariante; original: VarianteEntrada }[],
        ejes: EjeDeVariacion[],
        ambito: AmbitoDeGrupo,
    ): Promise<string[]> {
        const entradas = variantes.map((v) => ({ valores: v.valores, sku: v.original?.sku }));
        let ocupados = new Set<string>();
        for (let intento = 0; intento < 5; intento++) {
            const skus = asignarSkus(codigo, entradas, ejes, ocupados);
            const enBase = await this.products.skusExistentes({ userId: ambito.userId, storeId: ambito.storeId }, skus);
            const choques = skus.filter((s, i) => enBase.has(s.toLowerCase()) && !entradas[i].sku);
            const escritosOcupados = skus.find((s, i) => enBase.has(s.toLowerCase()) && !!entradas[i].sku);
            if (escritosOcupados) throw new ConflictException(`El SKU "${escritosOcupados}" ya está en uso en esta tienda. Cada variante necesita un SKU distinto.`);
            if (!choques.length) return skus;
            ocupados = new Set([...ocupados, ...enBase]);
        }
        throw new ConflictException('No se pudieron generar SKU libres para las variantes. Escríbelos a mano.');
    }

    private async guardarVariante(
        manager: EntityManager,
        grupo: ProductGroup,
        variante: { valores: ValoresDeVariante; original: VarianteEntrada },
        sku: string,
        ejes: EjeDeVariacion[],
        comun: { name: string; description?: string | null; category?: string | null; subCategory?: string | null; targetMarketplaces?: string[] | null },
        ambito: AmbitoDeGrupo,
    ): Promise<Product> {
        const etiqueta = etiquetaDe(variante.valores, ejes);
        const imagenes = (variante.original?.images ?? []).filter((u) => typeof u === 'string' && u.trim()).slice(0, 8);
        const producto = manager.create(Product, {
            name: `${comun.name} - ${etiqueta}`.slice(0, 250),
            sku,
            description: (comun.description ?? '').trim() || comun.name,
            category: comun.category ?? undefined,
            subCategory: comun.subCategory ?? undefined,
            targetMarketplaces: comun.targetMarketplaces ?? undefined,
            price: variante.original?.price ?? undefined,
            stock: variante.original?.stock ?? 0,
            status: 'draft',
            owner: { id: ambito.userId } as any,
            store: { id: ambito.storeId } as any,
            group: { id: grupo.id } as any,
            variantValues: variante.valores,
            images: imagenes.map((url) => manager.create(ProductImage, { url })),
        } as any);
        return this.guardar(manager, producto as any, sku);
    }

    /** Guarda; si la base rechaza por repetido (otra carga a la vez), lo traduce a un mensaje claro. */
    private async guardar<T extends object>(manager: EntityManager, entidad: T, clave: string): Promise<T> {
        try {
            return await manager.save(entidad as any) as T;
        } catch (error: any) {
            if (error?.code === '23505') {
                throw new ConflictException(`"${clave}" ya está en uso en esta tienda. Cada producto y cada grupo necesitan un código distinto.`);
            }
            throw error;
        }
    }

    private async productoDelAmbito(id: string, ambito: AmbitoDeGrupo): Promise<Product> {
        const producto = await this.productRepository.findOne({ where: { id }, relations: { store: true, owner: true, group: true } });
        const esDeLaTienda = !!producto && (producto.store?.id === ambito.storeId || (!producto.store && producto.owner?.id === ambito.userId));
        if (!producto || !esDeLaTienda) throw new NotFoundException('Producto no encontrado');
        return producto;
    }
}
