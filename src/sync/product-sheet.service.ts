import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { FalabellaApiService } from './falabella/falabella-api.service';
import { SyncScope, SyncService } from './sync.service';
import { SaveSheetDto } from './dto/save-sheet.dto';
import { ATRIBUTOS_DE_SISTEMA, esAtributoDeSistema } from './falabella/falabella-fields';

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
        const attrs: Record<string, any> = (product.aiAttributes as any) || {};
        const enlaces = await this.links.find({
            where: { product: { id: productId } },
            relations: { connection: { store: true } },
        });

        const canales: SheetChannel[] = [];
        for (const enlace of enlaces) {
            const cuenta = enlace.connection;
            if (!cuenta || cuenta.store?.id !== scope.storeId || !CANALES_CON_FICHA.includes(enlace.marketplace)) continue;
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
                aiTitle: product.aiTitle ?? null,
                aiDescription: product.aiDescription ?? null,
                descriptionHtml: attrs.descriptionHtml ?? null,
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
        };
    }

    private async hojaFalabella(base: Omit<SheetChannel, 'sent' | 'listo' | 'motivo'>, product: Product, attrs: Record<string, any>, cuenta: MarketplaceConnection): Promise<SheetChannel> {
        const creds = this.sync.credentialsOf(cuenta);
        const categoria = this.sync.categoriaFalabella(product);
        const definiciones = categoria ? await this.falabella.getCategoryAttributes(creds, categoria).catch(() => []) : [];
        const validacion = this.sync.toFalabellaInput(product, 'active', definiciones);
        const ruta = categoria
            ? (await this.falabella.getCategories(creds).catch((): { id: string; path: string }[] => [])).find((c) => c.id === String(categoria))?.path
            : undefined;

        return {
            ...base,
            sent: {
                name: this.sync.nombreParaFalabella(product.aiTitle || product.name),
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
                    .map((a) => ({
                        name: a.name,
                        label: a.label || a.name,
                        description: a.description,
                        required: a.isMandatory,
                        options: a.options,
                        value: String(this.sync.buscarAtributo(attrs, a.name) ?? ''),
                    }))
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
                title: (product.aiTitle || product.name).slice(0, 60),
                titleEditable: false,
                description: String(product.aiDescription || product.description || ''),
                categoryId: (product.marketplaceIds as any)?.mercadolibre_category_id ?? attrs.mercadolibre_category_id ?? null,
                attributes: this.sync.atributosParaMeli(product).map((a) => ({ id: a.id, value: a.value_name })),
            },
            listo: true,
        };
    }

    /** Guarda los cambios y programa el envío automático a los canales donde está publicado. */
    async saveSheet(scope: SyncScope, productId: string, dto: SaveSheetDto) {
        const product = await this.sync.findScopedProduct(scope, productId);
        const attrs: Record<string, any> = { ...((product.aiAttributes as any) || {}) };

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

        product.aiAttributes = attrs;
        await this.products.save(product);

        const canales = await this.sync.scheduleContentSync(productId);
        return { saved: true, willUpdate: canales.map((c) => c.marketplace) };
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
