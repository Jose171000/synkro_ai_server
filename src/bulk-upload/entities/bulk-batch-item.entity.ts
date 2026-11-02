import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/** «reintentado»: falló y se volvió a mandar en un lote nuevo (ya no cuenta como fallido de este). */
export type EstadoDeItem = 'pendiente' | 'listo' | 'fallido' | 'reintentado';

/** Un producto de una carga masiva y cómo le fue. `payload` guarda lo necesario para reintentarlo sin volver a subir el Excel. */
@Entity('bulk_batch_items')
@Index('IDX_bulk_batch_items_batch_sku', ['batchId', 'sku'])
export class BulkBatchItem {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    batchId: string;

    @Column()
    sku: string;

    @Column({ default: 'pendiente' })
    status: EstadoDeItem;

    /** Por qué falló (solo si `status` es «fallido»). */
    @Column('text', { nullable: true })
    error: string | null;

    @Column('uuid', { nullable: true })
    productId: string | null;

    /** Estado del envío a Falabella: «pendiente» (esperando su tanda), «enviado» o «rechazado»; nulo si no va a Falabella. */
    @Column({ type: 'varchar', nullable: true })
    falabellaStatus: string | null;

    /** Por qué Falabella no lo aceptó (solo si `falabellaStatus` es «rechazado»). */
    @Column({ type: 'text', nullable: true })
    falabellaError: string | null;

    /** Los datos del trabajo de la cola (precio, fotos ya subidas, canales…), para poder reintentarlo. */
    @Column('jsonb', { nullable: true })
    payload: Record<string, any> | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
