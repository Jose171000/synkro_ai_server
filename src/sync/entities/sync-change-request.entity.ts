import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { User } from '../../users/entities/user.entity';
import { Store } from '../../stores/entities/store.entity';
import { MarketplaceConnection } from './marketplace-connection.entity';

export type ChangeRequestField = 'price' | 'stock';
export type ChangeRequestStatus = 'pending' | 'approved' | 'rejected' | 'sent' | 'error';

/**
 * Un cambio de precio o stock que espera aprobación antes de llegar a un canal.
 *
 * Con el modo revisión activo, editar el inventario no toca el marketplace:
 * deja una de estas filas en `pending`. Al aprobarla se aplica el valor al
 * producto y se encola el envío; el resultado real (`sent` o `error`) lo
 * anota el worker cuando el canal responde.
 */
@Entity('sync_change_requests')
@Index('IDX_change_request_owner_status', ['requestedBy', 'status'])
export class SyncChangeRequest {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => Product, { onDelete: 'CASCADE' })
    product: Product;

    /** Tienda en la que se pidió el cambio: quien la revisa es su equipo. */
    @ManyToOne(() => Store, { onDelete: 'CASCADE', nullable: true })
    store: Store | null;

    /** Cuenta del canal a la que irá el cambio. */
    @ManyToOne(() => MarketplaceConnection, { onDelete: 'CASCADE', nullable: true })
    connection: MarketplaceConnection | null;

    @Column()
    marketplace: string;

    @Column({ type: 'varchar', length: 10 })
    field: ChangeRequestField;

    /** Se guardan como texto: sirven igual para precio (decimal) y stock (entero). */
    @Column({ type: 'varchar', nullable: true })
    previousValue: string | null;

    @Column({ type: 'varchar' })
    newValue: string;

    @Column({ type: 'varchar', length: 10, default: 'pending' })
    status: ChangeRequestStatus;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    requestedBy: User;

    /** Motivo del rechazo, o el error devuelto por el canal. */
    @Column('text', { nullable: true })
    resultMessage: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @Column({ type: 'timestamptz', nullable: true })
    resolvedAt: Date | null;
}
