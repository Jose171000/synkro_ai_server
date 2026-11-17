import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Una llamada a un modelo de IA con sus tokens reales y su costo en USD (calculado con la tarifa vigente al momento de la llamada). */
@Entity('ai_usage_log')
@Index('IDX_ai_usage_user_fecha', ['userId', 'createdAt'])
export class AiUsageLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Dueño al que se le cobra; vacío si la llamada ocurrió fuera de un contexto de usuario. */
    @Column({ type: 'uuid', nullable: true })
    userId: string | null;

    @Column({ type: 'varchar' })
    operation: string;

    @Column({ type: 'uuid', nullable: true })
    runId: string | null;

    @Column({ type: 'varchar' })
    provider: string;

    @Column({ type: 'varchar' })
    model: string;

    @Column({ type: 'int', default: 0 })
    promptTokens: number;

    @Column({ type: 'int', default: 0 })
    cachedTokens: number;

    @Column({ type: 'int', default: 0 })
    completionTokens: number;

    @Column({ type: 'numeric', precision: 14, scale: 8, default: 0, transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
    costUsd: number;

    /** false si el modelo no estaba en la tabla de tarifas: los tokens son reales pero el costo quedó en 0. */
    @Column({ type: 'boolean', default: true })
    priceKnown: boolean;

    @CreateDateColumn()
    createdAt: Date;
}
