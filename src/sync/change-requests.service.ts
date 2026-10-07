import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import { ChangeRequestStatus, SyncChangeRequest } from './entities/sync-change-request.entity';

const ESTADOS: ChangeRequestStatus[] = ['pending', 'approved', 'rejected', 'sent', 'error'];

/**
 * Cola de aprobación de cambios de precio y stock.
 *
 * Con el modo revisión encendido, editar el inventario no llega al canal:
 * queda aquí como solicitud pendiente. Aprobarla aplica el valor al producto
 * y encola el mismo job de inventario de siempre, así que el envío real sigue
 * teniendo un solo camino.
 */
@Injectable()
export class ChangeRequestsService {
    constructor(
        @InjectRepository(SyncChangeRequest)
        private readonly repository: Repository<SyncChangeRequest>,
        @InjectRepository(Product)
        private readonly productRepository: Repository<Product>,
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
        @InjectQueue('marketplace-sync-queue')
        private readonly syncQueue: Queue,
    ) { }

    async isReviewMode(userId: string): Promise<boolean> {
        const user = await this.userRepository.findOne({ where: { id: userId }, select: { id: true, syncReviewMode: true } });
        // Ante la duda se revisa: es el lado seguro.
        return user?.syncReviewMode ?? true;
    }

    async setReviewMode(userId: string, enabled: boolean) {
        await this.userRepository.update({ id: userId }, { syncReviewMode: enabled });
        return { reviewMode: enabled };
    }

    /**
     * Deja los cambios de un producto esperando aprobación: una solicitud por
     * canal y por campo que realmente cambie. Si ya había una pendiente para
     * lo mismo, se reemplaza: solo importa la última intención del usuario.
     */
    async createFromInventory(
        userId: string,
        product: Product,
        dto: { stock?: number; price?: number },
        marketplaces: string[],
    ): Promise<SyncChangeRequest[]> {
        const cambios: { field: 'price' | 'stock'; previous: string; next: string }[] = [];
        if (dto.price !== undefined && Number(dto.price) !== Number(product.price)) {
            cambios.push({ field: 'price', previous: String(product.price), next: String(dto.price) });
        }
        if (dto.stock !== undefined && dto.stock !== product.stock) {
            cambios.push({ field: 'stock', previous: String(product.stock), next: String(dto.stock) });
        }

        const creadas: SyncChangeRequest[] = [];
        for (const marketplace of marketplaces) {
            for (const cambio of cambios) {
                await this.repository.update(
                    { product: { id: product.id }, marketplace, field: cambio.field, status: 'pending', requestedBy: { id: userId } },
                    { status: 'rejected', resultMessage: 'Reemplazada por un cambio más reciente.', resolvedAt: new Date() },
                );
                creadas.push(await this.repository.save(this.repository.create({
                    product: { id: product.id } as Product,
                    marketplace,
                    field: cambio.field,
                    previousValue: cambio.previous,
                    newValue: cambio.next,
                    status: 'pending',
                    requestedBy: { id: userId } as User,
                })));
            }
        }
        return creadas;
    }

    async list(userId: string, status?: string) {
        if (status && !ESTADOS.includes(status as ChangeRequestStatus)) {
            throw new BadRequestException(`Estado inválido. Usa uno de: ${ESTADOS.join(', ')}.`);
        }
        return this.repository.find({
            where: { requestedBy: { id: userId }, ...(status ? { status: status as ChangeRequestStatus } : {}) },
            relations: { product: true },
            order: { createdAt: 'DESC' },
            take: 200,
        });
    }

    private async findOwned(id: string, userId: string): Promise<SyncChangeRequest> {
        const request = await this.repository.findOne({
            where: { id, requestedBy: { id: userId } },
            relations: { product: true },
        });
        if (!request) throw new NotFoundException('Solicitud de cambio no encontrada');
        return request;
    }

    /** Aplica el cambio al producto y lo manda al canal. */
    async approve(id: string, userId: string) {
        const request = await this.findOwned(id, userId);

        // La transición pendiente → aprobada es atómica: dos clics seguidos
        // no pueden encolar el mismo envío dos veces.
        const claimed = await this.repository.update({ id, status: 'pending' }, { status: 'approved' });
        if (!claimed.affected) {
            throw new BadRequestException(`La solicitud ya fue resuelta (${request.status}).`);
        }

        const product = await this.productRepository.findOne({ where: { id: request.product.id, owner: { id: userId } } });
        if (!product) {
            await this.finish(id, 'error', 'El producto ya no existe.');
            throw new NotFoundException('Producto no encontrado');
        }

        if (request.field === 'price') product.price = Number(request.newValue) as any;
        else product.stock = Number(request.newValue);
        await this.productRepository.save(product);

        await this.syncQueue.add('inventory', {
            productId: product.id,
            userId,
            marketplace: request.marketplace,
            changeRequestId: id,
        });

        return { id, status: 'approved', message: `Aprobado. Enviando ${request.field} a ${request.marketplace}.` };
    }

    async reject(id: string, userId: string, reason?: string) {
        await this.findOwned(id, userId);
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
