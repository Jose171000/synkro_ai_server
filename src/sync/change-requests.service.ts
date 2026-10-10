import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { IsNull, Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import { Store } from '../stores/entities/store.entity';
import { ChangeRequestStatus, SyncChangeRequest } from './entities/sync-change-request.entity';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';

const ESTADOS: ChangeRequestStatus[] = ['pending', 'approved', 'rejected', 'sent', 'error'];

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
            relations: { product: true, connection: true },
            order: { createdAt: 'DESC' },
            take: 200,
        });
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

        if (request.field === 'price') product.price = Number(request.newValue) as any;
        else product.stock = Number(request.newValue);
        await this.productRepository.save(product);

        await this.syncQueue.add('inventory', {
            productId: product.id,
            userId: scope.userId,
            marketplace: request.marketplace,
            connectionId: request.connection?.id,
            changeRequestId: id,
        });

        return { id, status: 'approved', message: `Aprobado. Enviando ${request.field} a ${request.marketplace}.` };
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

    private async finish(id: string, status: 'sent' | 'error', message: string | null) {
        await this.repository.update({ id }, { status, resultMessage: message, resolvedAt: new Date() });
    }
}
