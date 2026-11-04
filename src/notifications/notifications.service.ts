import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Notification, NotificationSeverity, NotificationType } from './entities/notification.entity';

export interface CreateNotificationInput {
    type: NotificationType;
    severity?: NotificationSeverity;
    title: string;
    body: string;
    marketplace?: string;
    meta?: Record<string, any>;
    /** La tienda del aviso. Si no se indica, se deduce del producto o de la cuenta de canal que trae `meta`. */
    storeId?: string;
}

/** Cuántos días se conservan antes de limpiarse. */
const RETENTION_DAYS = 60;

@Injectable()
export class NotificationsService {
    private readonly logger = new Logger('Notifications');

    constructor(
        @InjectRepository(Notification)
        private readonly repository: Repository<Notification>,
    ) { }

    /**
     * Registra un aviso para una cuenta.
     *
     * Nunca lanza: un fallo al notificar no puede tumbar la venta o la
     * publicación que lo originó. Si algo va mal, queda en el log del
     * servidor y el proceso principal sigue.
     */
    async notify(ownerId: string, input: CreateNotificationInput): Promise<void> {
        try {
            const storeId = input.storeId ?? await this.tiendaDe(input.meta);
            await this.repository.save(this.repository.create({
                type: input.type,
                severity: input.severity ?? 'info',
                title: input.title,
                body: input.body,
                marketplace: input.marketplace,
                meta: input.meta ?? null,
                owner: { id: ownerId } as any,
                store: storeId ? ({ id: storeId } as any) : null,
            }));
        } catch (error: any) {
            this.logger.error(`No se pudo guardar la notificación "${input.title}": ${error?.message}`);
        }
    }

    /**
     * La tienda de un suceso: la del producto o, si no hay producto, la de la cuenta del canal. Así los más de treinta sitios que
     * avisan no tienen que pasarla uno por uno. Si no se puede saber, el aviso queda sin tienda; nunca falla.
     */
    private async tiendaDe(meta?: Record<string, any>): Promise<string | undefined> {
        try {
            const manager = (this.repository as any).manager;
            if (!manager?.query) return undefined;
            const esId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
            if (esId(meta?.productId)) {
                const filas = await manager.query('SELECT "storeId" FROM products WHERE id::text = $1 LIMIT 1', [meta!.productId]);
                if (filas?.[0]?.storeId) return filas[0].storeId;
            }
            if (typeof meta?.feedId === 'string' && meta.feedId) {
                const filas = await manager.query('SELECT c."storeId" FROM marketplace_feeds f JOIN marketplace_connections c ON c.id = f."connectionId" WHERE f."externalFeedId" = $1 LIMIT 1', [meta.feedId]);
                if (filas?.[0]?.storeId) return filas[0].storeId;
            }
            if (esId(meta?.connectionId)) {
                const filas = await manager.query('SELECT "storeId" FROM marketplace_connections WHERE id::text = $1 LIMIT 1', [meta!.connectionId]);
                if (filas?.[0]?.storeId) return filas[0].storeId;
            }
        } catch (error: any) {
            this.logger.warn(`No se pudo deducir la tienda de un aviso: ${error?.message}`);
        }
        return undefined;
    }

    /** Avisos de una cuenta, del más reciente al más antiguo. */
    async list(ownerId: string, options: { limit?: number; unreadOnly?: boolean } = {}) {
        const qb = this.repository
            .createQueryBuilder('n')
            .leftJoin('n.store', 's')
            .addSelect(['s.id', 's.name'])
            .where('n.ownerId = :ownerId', { ownerId })
            .orderBy('n.createdAt', 'DESC')
            .take(Math.min(options.limit ?? 30, 100));

        if (options.unreadOnly) {
            qb.andWhere('n.read = false');
        }

        const [items, unread] = await Promise.all([
            qb.getMany(),
            this.repository.count({ where: { owner: { id: ownerId }, read: false } }),
        ]);

        return { items, unread };
    }

    async markRead(ownerId: string, id: string) {
        const result = await this.repository.update({ id, owner: { id: ownerId } as any }, { read: true });
        if (!result.affected) throw new NotFoundException('Notificación no encontrada.');
        return { message: 'Marcada como leída.' };
    }

    async markAllRead(ownerId: string) {
        await this.repository.update({ owner: { id: ownerId } as any, read: false }, { read: true });
        return { message: 'Todas marcadas como leídas.' };
    }

    async remove(ownerId: string, id: string) {
        const result = await this.repository.delete({ id, owner: { id: ownerId } as any });
        if (!result.affected) throw new NotFoundException('Notificación no encontrada.');
        return { message: 'Notificación eliminada.' };
    }

    /** Borra los avisos viejos para que la tabla no crezca sin límite. */
    async purgeOld(): Promise<number> {
        const limite = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const result = await this.repository.delete({ createdAt: LessThan(limite) });
        return result.affected ?? 0;
    }
}
