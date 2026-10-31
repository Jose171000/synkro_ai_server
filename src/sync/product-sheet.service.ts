import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { descripcionDeTexto } from './meli/descripcion-meli';
import { Product } from '../products/entities/product.entity';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { FalabellaApiService } from './falabella/falabella-api.service';
import { SyncScope, SyncService } from './sync.service';
import { preciosParaCanal } from './precios-por-canal';
import { fechaDeFalabella } from './falabella/falabella-product-xml';
import { SaveSheetDto } from './dto/save-sheet.dto';
import { atributosConVariante, nombreDeFamilia } from '../products/titulos-de-variante';
import { origenDeAtributo, origenesGenerales, quitarEstimado, quitarMarcaIA, CampoGeneral } from './origen-de-datos';
import { ATRIBUTOS_DE_SISTEMA, atributosObligatoriosAprendidos, claveDeAtributo, esAtributoDeSistema } from './falabella/falabella-fields';

const ATRIBUTOS_YA_CUBIERTOS_FALABELLA = ATRIBUTOS_DE_SISTEMA;

const CANALES_CON_FICHA = ['falabella', 'mercadolibre'];

export interface SheetChannel {
    marketplace: string;
    connectionId: string;
    account: string;
    status: string;
    lastError: string | null;
    permalink: string | null;
    /** Lo que se envía a ese canal, tal como se envía. */
    sent: Record<string, any>;
    listo: boolean;
    motivo?: string;
}

/** Precio y descuento de un producto en una cuenta de un canal. */
export interface SheetPrice {
    marketplace: string;
    connectionId: string;
    account: string;
    productPrice: number | null;
    productSalePrice: number | null;
    /** Lo que se envía a ese canal y de dónde sale: propio del canal, del producto, o lo que el canal ya tiene. */
    sent: { price: number; salePrice: number | null; saleStart: string | null; saleEnd: string | null; origin: { price: string; promo: string | null } };
    /** Lo que la persona fijó solo para este canal (vacío: se usa el del producto). */
    own: { price: number | null; salePrice: number | null; saleStart: string | null; saleEnd: string | null };
    /** Lo que el canal muestra hoy. */
    channel: { price: number | null; salePrice: number | null; stock: number | null };
    stock: number;
    canSetSale: boolean;
}

/**
 * La ficha de un producto: lo que se manda a cada marketplace, en un solo lugar y editable.
 * Al guardar un cambio se programa su envío automático a los canales donde el producto está publicado.
 */
@Injectable()
export class ProductSheetService {
    constructor(
        private readonly sync: SyncService,
        private readonly falabella: FalabellaApiService,
        @InjectRepository(ListingLink)
        private readonly links: Repository<ListingLink>,
        @InjectRepository(Product)
        private readonly products: Repository<Product>,
    ) { }

    async getSheet(scope: SyncScope, productId: string) {
        const product = await this.sync.findScopedProduct(scope, productId);
        // El grupo decide el nombre con el que sale cada variante: se carga para mostrar lo mismo que se envía.
        if (product.group === undefined) {
            const conGrupo = await this.products.findOne({ where: { id: productId }, relations: { group: true } });
            if (conGrupo?.group) product.group = conGrupo.group;
        }
        const attrs: Record<string, any> = (product.aiAttributes as any) || {};
        const enlaces = await this.links.find({
            where: { product: { id: productId } },
            relations: { connection: { store: true } },
        });

        const canales: SheetChannel[] = [];
        const precios: SheetPrice[] = [];
        for (const enlace of enlaces) {
            const cuenta = enlace.connection;
            if (!cuenta || cuenta.store?.id !== scope.storeId || !CANALES_CON_FICHA.includes(enlace.marketplace)) continue;
            precios.push(this.preciosDeEnlace(product, enlace, cuenta));
            const base = {
                marketplace: enlace.marketplace,
                connectionId: cuenta.id,
                account: cuenta.label || cuenta.externalNickname || cuenta.externalUserId,
                status: enlace.syncStatus,
                lastError: enlace.lastError ?? null,
                permalink: enlace.permalink ?? null,
            };
            canales.push(
                enlace.marketplace === 'falabella'
                    ? await this.hojaFalabella(base, product, attrs, cuenta)
                    : this.hojaMeli(base, product, attrs),
            );
        }

        return {
            product: {
                id: product.id,
                sku: product.sku,
                name: product.name,
                description: product.description,
                importedFrom: product.importedFrom ?? null,
                aiTitle: product.aiTitle ?? null,
                // Sin texto de la IA se muestra la descripción del producto o, si tampoco hay, la que sale de su ficha HTML; solo se guarda si la persona lo edita.
                aiDescription: product.aiDescription || descripcionDeTexto(product) || null,
                descriptionHtml: attrs.descriptionHtml ?? null,
                /** Quién escribió cada campo general: la IA o el canal del que se importó. Sin etiqueta: una persona. */
                origin: origenesGenerales(product, attrs),
                brand: attrs.brand ?? null,
                color: attrs.color ?? null,
                price: product.price !== null && product.price !== undefined ? Number(product.price) : null,
                stock: product.stock,
                images: (product.images ?? []).map((i) => i.url),
                measures: {
                    width: product.packageWidth, length: product.packageLength, height: product.packageHeight, weight: product.packageWeight,
                    estimated: !!attrs.estimated?.measures,
                },
            },
            channels: canales,
            prices: precios,
        };
    }

    /** Lo que se envía y lo que el canal muestra, de precio y descuento, para una cuenta. */
    private preciosDeEnlace(product: Product, enlace: ListingLink, cuenta: MarketplaceConnection): SheetPrice {
        const efectivos = preciosParaCanal(product, enlace);
        const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
        return {
            marketplace: enlace.marketplace,
            connectionId: cuenta.id,
            account: cuenta.label || cuenta.externalNickname || cuenta.externalUserId,
            productPrice: num(product.price),
            productSalePrice: num(product.salePrice),
            sent: {
                price: efectivos.price,
                salePrice: efectivos.promo?.salePrice ?? null,
                saleStart: efectivos.promo?.start ?? null,
                saleEnd: efectivos.promo?.end ?? null,
                origin: efectivos.origen,
            },
            own: {
                price: num(enlace.priceOverride),
                salePrice: num(enlace.salePriceOverride),
                saleStart: enlace.saleStartOverride ?? null,
                saleEnd: enlace.saleEndOverride ?? null,
            },
            channel: { price: num(enlace.regularPrice), salePrice: num(enlace.salePrice), stock: enlace.lastStockSynced ?? null },
            stock: product.stock,
            // El descuento puede tener una ventana de fechas que Synkro envía; sin precio de Falabella en el producto no hay nada que mostrar.
            canSetSale: enlace.marketplace === 'falabella',
        };
    }

    private async hojaFalabella(base: Omit<SheetChannel, 'sent' | 'listo' | 'motivo'>, product: Product, attrs: Record<string, any>, cuenta: MarketplaceConnection): Promise<SheetChannel> {
        const creds = this.sync.credentialsOf(cuenta);
        const categoria = this.sync.categoriaFalabella(product);
        const definiciones = categoria ? await this.falabella.getCategoryAttributes(creds, categoria).catch(() => []) : [];
        const validacion = this.sync.toFalabellaInput(product, 'active', definiciones);
        // Lo que se envía: el color o la talla de ESTA variante manda sobre los del molde del grupo.
        const efectivos = atributosConVariante(attrs, product.variantValues);
        const ruta = categoria
            ? (await this.falabella.getCategories(creds).catch((): { id: string; path: string }[] => [])).find((c) => c.id === String(categoria))?.path
            : undefined;

        return {
            ...base,
            sent: {
                name: 'input' in validacion ? validacion.input.name : this.sync.nombreParaFalabella(product.aiTitle || product.name),
                description: String(attrs.descriptionHtml || product.aiDescription || product.description || ''),
                isHtml: !!attrs.descriptionHtml,
                brand: attrs.brand || 'GENERICO',
                categoryId: categoria ? String(categoria) : null,
                categoryPath: ruta ?? null,
                // La categoría necesita que alguien la revise (la IA no estaba segura o Falabella rechazó la anterior).
                categoryReview: attrs._categoriaDudosa ? String(attrs._categoriaDudosa.motivo ?? 'revisa que la categoría sea la correcta') : null,
                measures: { width: product.packageWidth, length: product.packageLength, height: product.packageHeight, weight: product.packageWeight },
                attributes: definiciones
                    .filter((a) => !esAtributoDeSistema(a))
                    .map((a) => {
                        const value = String(this.sync.buscarAtributo(efectivos, a.name) ?? '');
                        return {
                            name: a.name,
                            label: a.label || a.name,
                            description: a.description,
                            required: a.isMandatory || atributosObligatoriosAprendidos(attrs).has(claveDeAtributo(a.name)),
                            options: a.options,
                            value,
                            origin: origenDeAtributo(attrs, 'falabella', a.name, value) ?? null,
                        };
                    })
                    .sort((x, y) => Number(y.required) - Number(x.required)),
            },
            listo: !('reason' in validacion),
            motivo: 'reason' in validacion ? validacion.reason : undefined,
        };
    }

    private hojaMeli(base: Omit<SheetChannel, 'sent' | 'listo' | 'motivo'>, product: Product, attrs: Record<string, any>): SheetChannel {
        return {
            ...base,
            sent: {
                // Una variante de un grupo sale con el nombre común de la familia: Mercado Libre le agrega solo el color de cada una.
                title: product.group
                    ? nombreDeFamilia(product.group.name || product.aiTitle || product.name, (product.group.axes ?? []).flatMap((e) => e.values))
                    : (product.aiTitle || product.name).slice(0, 60),
                titleEditable: false,
                description: String(product.aiDescription || product.description || ''),
                categoryId: (product.marketplaceIds as any)?.mercadolibre_category_id ?? attrs.mercadolibre_category_id ?? null,
                attributes: this.sync.atributosParaMeli(product).map((a) => ({ id: a.id, value: a.value_name, origin: origenDeAtributo(attrs, 'mercadolibre', a.id, a.value_name) ?? null })),
            },
            listo: true,
        };
    }

    /** Guarda los cambios y programa el envío automático a los canales donde está publicado. */
    async saveSheet(scope: SyncScope, productId: string, dto: SaveSheetDto) {
        const product = await this.sync.findScopedProduct(scope, productId);
        let attrs: Record<string, any> = { ...((product.aiAttributes as any) || {}) };

        // Lo que la persona cambia deja de ser «escrito por la IA»: se anota qué campos cambian, comparando con lo que había.
        const editados: CampoGeneral[] = [];
        const cambia = (nuevo: string | undefined, actual: unknown) => nuevo !== undefined && nuevo.trim() !== String(actual ?? '').trim();
        if (cambia(dto.aiTitle, product.aiTitle)) editados.push('aiTitle');
        if (cambia(dto.aiDescription, product.aiDescription)) editados.push('aiDescription');
        if (cambia(dto.descriptionHtml, attrs.descriptionHtml)) editados.push('descriptionHtml');
        if (cambia(dto.brand, attrs.brand)) editados.push('brand');
        const atributosEditados = Object.entries(dto.attributes ?? {}).filter(([k, v]) => String(v ?? '').trim() !== String(attrs[k] ?? '').trim()).map(([k]) => k);
        const atributosMeliEditados = Object.entries(dto.mercadolibreAttributes ?? {}).filter(([k, v]) => String(v ?? '').trim() !== String(attrs.mercadolibre_attributes?.[k] ?? '').trim()).map(([k]) => k);

        if (dto.name !== undefined) {
            if (!dto.name.trim()) throw new BadRequestException('El nombre no puede quedar vacío.');
            product.name = dto.name.trim();
        }
        if (dto.description !== undefined) product.description = dto.description;
        if (dto.aiTitle !== undefined) product.aiTitle = dto.aiTitle.trim() || (null as any);
        if (dto.aiDescription !== undefined) product.aiDescription = dto.aiDescription.trim() || (null as any);
        if (dto.descriptionHtml !== undefined) {
            if (dto.descriptionHtml.trim()) attrs.descriptionHtml = dto.descriptionHtml;
            else delete attrs.descriptionHtml;
        }
        if (dto.brand !== undefined) attrs.brand = dto.brand.trim() || 'GENERICO';
        for (const [clave, valor] of Object.entries(dto.attributes ?? {})) {
            if (String(valor ?? '').trim()) attrs[clave] = String(valor).trim();
            else delete attrs[clave];
        }
        if (dto.mercadolibreAttributes) {
            const previos: Record<string, any> = { ...(attrs.mercadolibre_attributes ?? {}) };
            for (const [id, valor] of Object.entries(dto.mercadolibreAttributes)) {
                if (String(valor ?? '').trim()) previos[id] = String(valor).trim();
                else delete previos[id];
            }
            attrs.mercadolibre_attributes = previos;
        }
        if (dto.measures) {
            product.packageWidth = Math.round(dto.measures.width);
            product.packageLength = Math.round(dto.measures.length);
            product.packageHeight = Math.round(dto.measures.height);
            product.packageWeight = dto.measures.weight;
            // Quien guarda las medidas las está revisando.
            if (attrs.estimated) attrs.estimated = { ...attrs.estimated, measures: false };
        }

        attrs = quitarMarcaIA(attrs, editados);
        attrs = quitarEstimado(attrs, 'falabella', atributosEditados);
        attrs = quitarEstimado(attrs, 'mercadolibre', atributosMeliEditados);
        product.aiAttributes = attrs;
        await this.products.save(product);

        const preciosEnviados = dto.prices ? await this.guardarPrecios(scope, product, dto.prices) : [];
        // Guardar solo precios no toca el contenido de los canales.
        const soloPrecios = !!dto.prices && Object.keys(dto).every((k) => k === 'prices');
        const canales = soloPrecios ? [] : await this.sync.scheduleContentSync(productId);
        return { saved: true, willUpdate: canales.map((c) => c.marketplace), pricesSent: preciosEnviados };
    }

    /**
     * Guarda el precio y el descuento propios de cada cuenta y programa su envío a ese canal.
     * Un valor vacío quita el propio y vuelve a usarse el del producto. Devuelve las cuentas a las que se enviará.
     */
    private async guardarPrecios(scope: SyncScope, product: Product, prices: NonNullable<SaveSheetDto['prices']>): Promise<string[]> {
        const enviados: string[] = [];
        for (const p of prices) {
            const enlace = await this.links.findOne({
                where: { product: { id: product.id }, connection: { id: p.connectionId } },
                relations: { connection: { store: true } },
            });
            if (!enlace || enlace.connection?.store?.id !== scope.storeId || !CANALES_CON_FICHA.includes(enlace.marketplace)) {
                throw new BadRequestException('Esa cuenta no tiene este producto publicado.');
            }
            const vacio = (v: unknown) => v === null || v === undefined || v === '';
            const precio = vacio(p.price) ? null : Number(p.price);
            // Mercado Libre no recibe descuentos desde aquí: se maneja en su propia herramienta de promociones.
            const conDescuento = enlace.marketplace === 'falabella' && !vacio(p.salePrice);
            const descuento = conDescuento ? Number(p.salePrice) : null;
            const inicio = conDescuento ? fechaDeFalabella(p.saleStart) : null;
            const fin = conDescuento ? fechaDeFalabella(p.saleEnd) : null;
            if (conDescuento && p.saleStart && !inicio) throw new BadRequestException('La fecha de inicio no es válida (usa AAAA-MM-DD).');
            if (conDescuento && p.saleEnd && !fin) throw new BadRequestException('La fecha de fin no es válida (usa AAAA-MM-DD).');
            if (inicio && fin && fin < inicio) throw new BadRequestException('La fecha de fin no puede ser anterior a la de inicio.');
            const base = precio ?? Number(product.price);
            if (descuento !== null && !(descuento > 0 && descuento < base)) {
                throw new BadRequestException(`El descuento en ${enlace.marketplace === 'falabella' ? 'Falabella' : 'este canal'} debe ser menor que su precio regular (${base.toFixed(2)}).`);
            }

            const antes = [enlace.priceOverride, enlace.salePriceOverride, enlace.saleStartOverride, enlace.saleEndOverride].map((v) => (vacio(v) ? null : String(v)));
            const despues = [precio, descuento, inicio, fin].map((v) => (vacio(v) ? null : String(v)));
            if (antes.every((v, i) => v === despues[i])) continue;

            enlace.priceOverride = precio;
            enlace.salePriceOverride = descuento;
            enlace.saleStartOverride = inicio;
            enlace.saleEndOverride = fin;
            await this.links.save(enlace);
            // Si el precio cambió, el siguiente envío debe mandarlo aunque coincida con el último anotado.
            if (enlace.syncStatus === 'published' || enlace.syncStatus === 'paused') {
                await this.sync.programarEnvioDeInventario(scope.userId, product.id, enlace.marketplace, enlace.connection!.id);
                enviados.push(enlace.marketplace);
            }
        }
        return enviados;
    }

    /** Envía ya, sin esperar el retraso, el contenido actual a cada canal publicado. */
    async syncNow(scope: SyncScope, productId: string) {
        const product = await this.sync.findScopedProduct(scope, productId);
        const enlaces = await this.links.find({
            where: { product: { id: product.id }, syncStatus: 'published' },
            relations: { connection: { store: true } },
        });
        const resultados: { marketplace: string; ok: boolean; message: string }[] = [];
        for (const enlace of enlaces) {
            if (enlace.connection?.store?.id !== scope.storeId || !CANALES_CON_FICHA.includes(enlace.marketplace)) continue;
            const r = await this.sync.runContentSync(product.id, enlace.connection.id, enlace.marketplace);
            resultados.push({ marketplace: enlace.marketplace, ...r });
        }
        return { results: resultados };
    }
}
