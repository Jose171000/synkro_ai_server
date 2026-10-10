import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index, Unique } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Store } from '../../stores/entities/store.entity';
import { MarketplaceConnection } from './marketplace-connection.entity';

/**
 * A confirmed sale pulled from a marketplace (via webhook or backfill).
 * Feeds the client sales report and the future orders panel.
 */
@Entity('marketplace_orders')
@Unique('UQ_order_marketplace_external', ['marketplace', 'externalId'])
export class MarketplaceOrder {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    marketplace: string; // 'mercadolibre'

    @Column()
    externalId: string; // ID de la orden en el marketplace

    @ManyToOne(() => User, { nullable: false })
    @Index()
    owner: User;

    /** Tienda a la que pertenece la venta: es la que la ve en sus analíticas. */
    @ManyToOne(() => Store, { onDelete: 'SET NULL', nullable: true })
    @Index()
    store: Store | null;

    /** Cuenta del canal por la que entró la venta. */
    @ManyToOne(() => MarketplaceConnection, { onDelete: 'SET NULL', nullable: true })
    connection: MarketplaceConnection | null;

    @Column('decimal', { precision: 12, scale: 2 })
    totalAmount: number;

    @Column({ type: 'varchar', length: 5, default: 'PEN' })
    currency: string;

    @Column({ default: 1 })
    itemsCount: number;

    // Snapshot de los ítems: [{ sku, title, quantity, unitPrice }]
    @Column({ type: 'jsonb', nullable: true })
    items: any[];

    @Column({ type: 'varchar', length: 30, default: 'paid' })
    status: string;

    /** Número de pedido tal como lo ve el cliente en el canal. */
    @Column({ type: 'varchar', nullable: true })
    orderNumber: string | null;

    @Column({ type: 'varchar', nullable: true })
    customerName: string | null;

    /** Fecha máxima para despachar la venta. */
    @Column({ type: 'timestamptz', nullable: true })
    shipByDate: Date | null;

    /** Cliente, envío, pago y notas, en un formato común a todos los canales. */
    @Column({ type: 'jsonb', nullable: true })
    details: any | null;

    @Column({ type: 'timestamptz' })
    orderDate: Date;

    @CreateDateColumn()
    createdAt: Date;
}
