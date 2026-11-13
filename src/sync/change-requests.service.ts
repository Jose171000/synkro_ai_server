import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import { Store } from '../stores/entities/store.entity';
import { ChangeRequestStatus, SyncChangeRequest } from './entities/sync-change-request.entity';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { ListingLink } from './entities/listing-link.entity';
import { descuentoDeValor } from './ripley/ripley-oferta';

const ESTADOS: ChangeRequestStatus[] = ['pending', 'approved', 'rejected', 'sent', 'error', 'skipped'];

/**
 * El descuento general de un producto (el de «Precios») viaja en la solicitud con la marca «|g» al final: al aprobarlo se guarda en el
 * producto. Sin la marca es el descuento propio de una cuenta. Ejemplos: «70|2026-08-02|2026-12-01|g», «quitar|g».
 */
export const conMarcaGeneral = (valor: string): string => `${valor}|g`;
export function sinMarcaGeneral(valor: string): { valor: string; general: boolean } {
    const t = String(valor ?? '').trim();
    return t.endsWith('|g') ? { valor: t.slice(0, -2), general: true } : { valor: t, general: false };
}

/** Quién actúa y en qué tienda. */
export interface ChangeScope {
    userId: string;
    storeId: string;
}

/**
 * Cola de aprobación de cambios de precio y stock.
 *
 * Con el modo revisión de la tienda encendido, editar el inventario no llega
 * al canal: queda aquí como solicitud pendiente. Aprobarla aplica el valor al
 * producto y encola el mismo job de inventario de siempre, así que el envío
 * real sigue teniendo un solo camino. Cada solicitud apunta a UNA cuenta del
 * canal, porque una tienda puede tener varias del mismo marketplace.
 */
@Injectable()
export class ChangeRequestsService {
    constructor(
        @InjectRepository(SyncChangeRequest)
        private readonly repository: Repository<SyncChangeRequest>,
        @InjectRepository(Product)
        private readonly productRepository: Repository<Product>,
        @InjectRepository(Store)
        private readonly storeRepository: Repository<Store>,
        @InjectQueue('marketplace-sync-queue')
        private readonly syncQueue: Queue,
        // Solo lo usa la aprobación de un descuento de Falabella (se guarda en la publicación de esa cuenta).
        @InjectRepository(ListingLink)
        private readonly listingLinkRepository?: Repository<ListingLink>,
    ) { }

    async isReviewMode(storeId: string): Promise<boolean> {
        const store = await this.storeRepository.findOne({ where: { id: storeId }, select: { id: true, syncReviewMode: true } });
        // Ante la duda se revisa: es el lado seguro.
        return store?.syncReviewMode ?? true;
    }

    async setReviewMode(storeId: string, enabled: boolean) {
        await this.storeRepository.update({ id: storeId }, { syncReviewMode: enabled });
        return { reviewMode: enabled };
    }

    /**
     * Deja los cambios de un producto esperando aprobación: una solicitud por
     * cuenta y por campo que realmente cambie. Si ya había una pendiente para
     * lo mismo, se reemplaza: solo importa la última intención del usuario.
     */
    async createFromInventory(
        scope: ChangeScope,
        product: Product,
        dto: { stock?: number; price?: number },
        targets: { marketplace: string; connectionId: string }[],
    ): Promise<SyncChangeRequest[]> {
        const cambios: { field: 'price' | 'stock'; previous: string; next: string }[] = [];
        if (dto.price !== undefined && Number(dto.price) !== Number(product.price)) {
            cambios.push({ field: 'price', previous: String(product.price), next: String(dto.price) });
        }
        if (dto.stock !== undefined && dto.stock !== product.stock) {
            cambios.push({ field: 'stock', previous: String(product.stock), next: String(dto.stock) });
        }

        const creadas: SyncChangeRequest[] = [];
        for (const target of targets) {
            for (const cambio of cambios) {
                await this.repository.update(
                    {
                        product: { id: product.id },
                        connection: { id: target.connectionId },
                        field: cambio.field,
                        status: 'pending',
                    },
                    { status: 'rejected', resultMessage: 'Reemplazada por un cambio más reciente.', resolvedAt: new Date() },
                );
                creadas.push(await this.repository.save(this.repository.create({
                    product: { id: product.id } as Product,
                    store: { id: scope.storeId } as Store,
                    connection: { id: target.connectionId } as MarketplaceConnection,
                    marketplace: target.marketplace,
                    field: cambio.field,
                    previousValue: cambio.previous,
                    newValue: cambio.next,
                    status: 'pending',
                    requestedBy: { id: scope.userId } as User,
                })));
            }
        }
        return creadas;
    }

    /**
     * Reenviar a UNA cuenta el stock que Synkro tiene, porque el canal quedó con otro número. Con el modo revisión encendido es una
     * solicitud más (el valor ya está en el producto: aprobarla solo lo manda). Reemplaza a una pendiente anterior de lo mismo.
     */
    async createStockResend(scope: ChangeScope, product: Product, target: { marketplace: string; connectionId: string; channelStock: number | null }): Promise<SyncChangeRequest> {
        return this.createResend(scope, product, 'stock', target, target.channelStock, String(product.stock));
    }

    /** Lo mismo para el precio: el valor ya está en el producto, aprobarla solo lo manda a esa cuenta. */
    async createPriceResend(scope: ChangeScope, product: Product, target: { marketplace: string; connectionId: string; channelPrice: number | null }): Promise<SyncChangeRequest> {
        return this.createResend(scope, product, 'price', target, target.channelPrice, String(product.price));
    }

    /**
     * Un descuento para UNA cuenta (hoy, Ripley). Espera aprobación como cualquier cambio de precio. Aprobarla no toca el producto:
     * solo manda el descuento a esa cuenta. Reemplaza a otra pendiente de lo mismo.
     */
    async createPromoRequest(scope: ChangeScope, product: Product, target: { marketplace: string; connectionId: string; previous: string; next: string }): Promise<SyncChangeRequest> {
        await this.repository.update(
            { product: { id: product.id }, connection: { id: target.connectionId }, field: 'promo', status: 'pending' },
            { status: 'rejected', resultMessage: 'Reemplazada por un cambio más reciente.', resolvedAt: new Date() },
        );
        return this.repository.save(this.repository.create({
            product: { id: product.id } as Product,
            store: { id: scope.storeId } as Store,
            connection: { id: target.connectionId } as MarketplaceConnection,
            marketplace: target.marketplace,
            field: 'promo',
            previousValue: target.previous,
            newValue: target.next,
            status: 'pending',
            requestedBy: { id: scope.userId } as User,
        }));
    }

    private async createResend(
        scope: ChangeScope,
        product: Product,
        field: 'stock' | 'price',
        target: { marketplace: string; connectionId: string },
        channelValue: number | null,
        newValue: string,
    ): Promise<SyncChangeRequest> {
        await this.repository.update(
            { product: { id: product.id }, connection: { id: target.connectionId }, field, status: 'pending' },
            { status: 'rejected', resultMessage: 'Reemplazada por un cambio más reciente.', resolvedAt: new Date() },
        );
        return this.repository.save(this.repository.create({
            product: { id: product.id } as Product,
            store: { id: scope.storeId } as Store,
            connection: { id: target.connectionId } as MarketplaceConnection,
            marketplace: target.marketplace,
            field,
            previousValue: channelValue == null ? '' : String(channelValue),
            newValue,
            status: 'pending',
            requestedBy: { id: scope.userId } as User,
        }));
    }

    /**
     * Las solicitudes que ya están en camino: pendientes de aprobar o aprobadas hace poco y todavía sin resultado. La conciliación
     * no avisa de una diferencia que alguien ya está resolviendo. Clave: «productoId|cuentaId|campo».
     */
    async enCamino(): Promise<Set<string>> {
        const haceSeisHoras = new Date(Date.now() - 6 * 3600_000);
        const lista = await this.repository.find({
            where: [{ status: 'pending' }, { status: 'approved', createdAt: MoreThan(haceSeisHoras) }],
            relations: { product: true, connection: true },
        });
        return new Set(lista.filter((r) => r.product?.id && r.connection?.id).map((r) => `${r.product.id}|${r.connection!.id}|${r.field}`));
    }

    /**
     * Las solicitudes de la tienda. Las anteriores a las tiendas no tienen
     * tienda asignada: se muestran a quien las pidió, para no perderlas.
     */
    async list(scope: ChangeScope, status?: string) {
        if (status && !ESTADOS.includes(status as ChangeRequestStatus)) {
            throw new BadRequestException(`Estado inválido. Usa uno de: ${ESTADOS.join(', ')}.`);
        }
        const estado = status ? { status: status as ChangeRequestStatus } : {};
        return this.repository.find({
            where: [
                { store: { id: scope.storeId }, ...estado },
                { store: IsNull(), requestedBy: { id: scope.userId }, ...estado },
            ],
            // El grupo del producto permite mostrar «Sandalias… · 20 variantes» en vez de 20 filas sueltas.
            relations: { product: { group: true }, connection: true },
            order: { createdAt: 'DESC' },
            take: 200,
        });
    }

    /**
     * Aprueba varias solicitudes de una vez (un grupo de variantes, o todas las pendientes). Cada una sigue las reglas de siempre;
     * una que ya estaba resuelta o falla no frena a las demás.
     */
    async approveMany(ids: string[], scope: ChangeScope) {
        const unicos = [...new Set(ids)];
        const r = { aprobadas: 0, omitidas: [] as { id: string; motivo: string }[] };
        for (const id of unicos) {
            try {
                await this.approve(id, scope);
                r.aprobadas++;
            } catch (error: any) {
                r.omitidas.push({ id, motivo: String(error?.message ?? 'No se pudo aprobar.').slice(0, 200) });
            }
        }
        return r;
    }

    async rejectMany(ids: string[], scope: ChangeScope, reason?: string) {
        const unicos = [...new Set(ids)];
        const r = { rechazadas: 0, omitidas: [] as { id: string; motivo: string }[] };
        for (const id of unicos) {
            try {
                await this.reject(id, scope, reason);
                r.rechazadas++;
            } catch (error: any) {
                r.omitidas.push({ id, motivo: String(error?.message ?? 'No se pudo rechazar.').slice(0, 200) });
            }
        }
        return r;
    }

    private async findInStore(id: string, scope: ChangeScope): Promise<SyncChangeRequest> {
        const request = await this.repository.findOne({
            where: [
                { id, store: { id: scope.storeId } },
                { id, store: IsNull(), requestedBy: { id: scope.userId } },
            ],
            relations: { product: true, connection: true },
        });
        if (!request) throw new NotFoundException('Solicitud de cambio no encontrada');
        return request;
    }

    /** Aplica el cambio al producto y lo manda a la cuenta del canal. */
    async approve(id: string, scope: ChangeScope) {
        const request = await this.findInStore(id, scope);

        // La transición pendiente → aprobada es atómica: dos clics seguidos
        // no pueden encolar el mismo envío dos veces.
        const claimed = await this.repository.update({ id, status: 'pending' }, { status: 'approved' });
        if (!claimed.affected) {
            throw new BadRequestException(`La solicitud ya fue resuelta (${request.status}).`);
        }

        const product = await this.productRepository.findOne({ where: { id: request.product.id } });
        if (!product) {
            await this.finish(id, 'error', 'El producto ya no existe.');
            throw new NotFoundException('Producto no encontrado');
        }

        // Un descuento por canal no cambia el producto: solo se manda a esa cuenta (el general de Falabella sí se guarda en el producto).
        const { valor: valorDescuento, general } = sinMarcaGeneral(request.newValue);
        const descuento = request.field === 'promo' ? descuentoDeValor(valorDescuento) : null;
        if (request.field === 'promo' && !descuento) {
            await this.finish(id, 'error', 'El descuento de la solicitud no es válido.');
            throw new BadRequestException('El descuento de la solicitud no es válido.');
        }
        if (request.field === 'promo' && request.marketplace === 'falabella') {
            const quitado = await this.aplicarDescuentoDeFalabella(request, product, descuento!, general);
            // Quitar un descuento no se manda: Falabella lo conserva hasta que se quita en su Seller Center.
            if (quitado) {
                const aviso = 'Descuento quitado de Synkro. Si ya estaba en Falabella, quítalo también desde el Seller Center.';
                await this.markSkipped(id, aviso);
                return { id, status: 'approved', message: aviso };
            }
        }
        if (request.field === 'price') {
            product.price = Number(request.newValue) as any;
            await this.productRepository.save(product);
        } else if (request.field === 'stock') {
            product.stock = Number(request.newValue);
            await this.productRepository.save(product);
        }

        // Ripley manda un solo campo a la vez: la solicitud dice cuál (los demás canales mandan los dos como siempre).
        await this.syncQueue.add('inventory', {
            productId: product.id,
            userId: scope.userId,
            marketplace: request.marketplace,
            connectionId: request.connection?.id,
            changeRequestId: id,
            conPrecio: request.field === 'price',
            conStock: request.field === 'stock',
            ...(descuento ? { conDescuento: true, descuento } : {}),
        });

        return { id, status: 'approved', message: `Aprobado. Enviando ${request.field} a ${request.marketplace}.` };
    }

    /**
     * Guarda un descuento aprobado de Falabella: el general, en el producto; el de una cuenta, en la publicación de esa cuenta.
     * Devuelve true si era quitarlo (no hay nada que mandar al canal).
     */
    private async aplicarDescuentoDeFalabella(request: SyncChangeRequest, product: Product, descuento: { precio: number | null; desde?: string | null; hasta?: string | null }, general: boolean): Promise<boolean> {
        const quitar = descuento.precio === null;
        const precio = quitar ? null : descuento.precio;
        const desde = quitar ? null : descuento.desde || null;
        const hasta = quitar ? null : descuento.hasta || null;
        if (general) {
            product.salePrice = precio as any;
            product.saleStartDate = desde as any;
            product.saleEndDate = hasta as any;
            await this.productRepository.save(product);
            return quitar;
        }
        const enlace = request.connection?.id && this.listingLinkRepository
            ? await this.listingLinkRepository.findOne({ where: { product: { id: product.id }, connection: { id: request.connection.id } } })
            : null;
        if (!enlace) {
            await this.finish(request.id, 'error', 'No se encontró la publicación de esa cuenta.');
            throw new NotFoundException('No se encontró la publicación de esa cuenta.');
        }
        enlace.salePriceOverride = precio as any;
        enlace.saleStartOverride = desde as any;
        enlace.saleEndOverride = hasta as any;
        await this.listingLinkRepository!.save(enlace);
        return quitar;
    }

    async reject(id: string, scope: ChangeScope, reason?: string) {
        await this.findInStore(id, scope);
        const result = await this.repository.update(
            { id, status: 'pending' },
            { status: 'rejected', resultMessage: reason?.trim() || null, resolvedAt: new Date() },
        );
        if (!result.affected) throw new BadRequestException('La solicitud ya fue resuelta.');
        return { id, status: 'rejected' };
    }

    /** Lo llama el worker cuando el canal responde: cierra la solicitud. */
    async markResult(id: string, ok: boolean, message?: string) {
        await this.finish(id, ok ? 'sent' : 'error', ok ? null : message ?? 'Error desconocido');
    }

    /** El canal no recibió el cambio a propósito: la solicitud queda como «No enviado» con el motivo, nunca como «Enviado». */
    async markSkipped(id: string, message: string) {
        await this.finish(id, 'skipped', message);
    }

    private async finish(id: string, status: 'sent' | 'error' | 'skipped', message: string | null) {
        await this.repository.update({ id }, { status, resultMessage: message, resolvedAt: new Date() });
    }
}
