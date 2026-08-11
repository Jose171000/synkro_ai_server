import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index, Unique } from 'typeorm';
import { User } from '../../users/entities/user.entity';

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

    @Column({ type: 'timestamptz' })
    orderDate: Date;

    @CreateDateColumn()
    createdAt: Date;
}
