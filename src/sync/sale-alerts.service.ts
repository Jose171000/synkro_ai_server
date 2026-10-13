import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketplaceOrder } from './entities/marketplace-order.entity';
import { StoreMember } from '../stores/entities/store-member.entity';
import { Store } from '../stores/entities/store.entity';
import { User } from '../users/entities/user.entity';
import { MailService } from '../mail/mail.service';

/**
 * Avisa por correo de cada venta nueva al dueño de la tienda y a todo su
 * equipo (miembros de cualquier rol). Solo ventas que llegan en vivo: el
 * historial importado no dispara correos.
 */
@Injectable()
export class SaleAlertsService {
    private readonly logger = new Logger(SaleAlertsService.name);

    constructor(
        @InjectRepository(StoreMember)
        private readonly members: Repository<StoreMember>,
        @InjectRepository(Store)
        private readonly stores: Repository<Store>,
        @InjectRepository(User)
        private readonly users: Repository<User>,
        private readonly mail: MailService,
    ) { }

    /** Correos a avisar: el dueño de la tienda y su equipo, sin repetidos ni cuentas desactivadas. */
    async destinatarios(order: Pick<MarketplaceOrder, 'store' | 'owner'>): Promise<{ email: string; name: string }[]> {
        const personas: User[] = [];
        const storeId = order.store?.id;

        if (storeId) {
            const filas = await this.members.find({ where: { store: { id: storeId } }, relations: { user: true } });
            personas.push(...filas.map((f) => f.user));
            const tienda = await this.stores.findOne({ where: { id: storeId }, relations: { owner: true } });
            if (tienda?.owner) personas.push(tienda.owner);
        }
        // Venta sin tienda (cuentas antiguas): al menos se avisa a quien la conectó.
        if (!personas.length && order.owner?.id) {
            const dueno = await this.users.findOne({ where: { id: order.owner.id } });
            if (dueno) personas.push(dueno);
        }

        const vistos = new Set<string>();
        const lista: { email: string; name: string }[] = [];
        for (const p of personas) {
            if (!p?.email || p.isActive === false || p.approvalStatus === 'rejected') continue;
            const clave = p.email.trim().toLowerCase();
            if (vistos.has(clave)) continue;
            vistos.add(clave);
            lista.push({ email: p.email, name: p.name || 'equipo' });
        }
        return lista;
    }

    /** Nunca lanza: un correo que falla no puede afectar el registro de la venta. */
    async notificar(order: MarketplaceOrder, canal: string): Promise<void> {
        try {
            const storeId = order.store?.id;
            const tienda = storeId ? await this.stores.findOne({ where: { id: storeId } }) : null;
            const destinatarios = await this.destinatarios(order);
            if (!destinatarios.length) return;

            const items = (order.items ?? []).map((l: any) => ({
                title: l.title ?? l.sku ?? 'Producto',
                sku: l.sku ?? null,
                quantity: Number(l.quantity) || 1,
                unitPrice: Number(l.unitPrice || 0).toFixed(2),
            }));

            await Promise.allSettled(
                destinatarios.map((d) =>
                    this.mail.sendSaleAlert(d.email, {
                        name: d.name,
                        storeName: tienda?.name ?? 'tu tienda',
                        channel: canal,
                        orderNumber: order.orderNumber ?? order.externalId,
                        customerName: order.customerName ?? null,
                        currency: order.currency,
                        total: Number(order.totalAmount || 0).toFixed(2),
                        itemsCount: order.itemsCount,
                        items,
                        shipBy: order.shipByDate ? new Date(order.shipByDate).toLocaleDateString('es-PE', { dateStyle: 'long', timeZone: 'America/Lima' }) : null,
                    }),
                ),
            );
        } catch (error: any) {
            this.logger.warn(`Aviso de venta ${order?.externalId}: ${error?.message}`);
        }
    }
}
