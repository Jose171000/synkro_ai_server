import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Una carga masiva de productos. El id es el mismo `batchId` que usan los trabajos de la cola y Redis.
 * Es el registro que sobrevive a Redis (que caduca a las 24 h): cuántos productos llevaba, cómo terminó y qué filas se rechazaron.
 */
@Entity('bulk_batches')
@Index('IDX_bulk_batches_user', ['userId', 'createdAt'])
export class BulkBatch {
    @PrimaryColumn('uuid')
    id: string;

    @Column('uuid')
    userId: string;

    @Column('uuid', { nullable: true })
    storeId: string | null;

    /** Productos que entraron a la cola (no cuenta las filas rechazadas). */
    @Column('int', { default: 0 })
    total: number;

    @Column({ default: 'running' })
    status: 'running' | 'done';

    /** Filas del Excel que no llegaron a la cola, con su motivo («Fila 5: …»). */
    @Column('jsonb', { default: () => "'[]'" })
    rejected: string[];

    @CreateDateColumn()
    createdAt: Date;

    @Column({ type: 'timestamp', nullable: true })
    finishedAt: Date | null;
}
