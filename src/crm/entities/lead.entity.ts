import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, ManyToOne } from 'typeorm';
import { User } from '../../users/entities/user.entity';

/** Etapas del embudo comercial. */
export const LEAD_STAGES = [
    'nuevo',
    'contactado',
    'calificado',
    'propuesta',
    'ganado',
    'perdido',
] as const;

export type LeadStage = typeof LEAD_STAGES[number];

/**
 * Un prospecto del CRM. Los campos son deliberadamente laxos porque
 * provienen de hojas de cálculo donde cada fila viene como venga.
 */
@Entity('leads')
export class Lead {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    @Index()
    name: string;

    @Column({ nullable: true })
    company: string;

    @Column({ nullable: true })
    @Index()
    email: string;

    @Column({ nullable: true })
    phone: string;

    /** De dónde vino: instagram, referido, web, campaña... */
    @Column({ nullable: true })
    source: string;

    @Column({ type: 'varchar', length: 20, default: 'nuevo' })
    stage: LeadStage;

    /** Valor estimado del negocio, si se conoce. */
    @Column('decimal', { precision: 12, scale: 2, nullable: true })
    estimatedValue: number;

    @Column({ type: 'text', nullable: true })
    notes: string;

    /** Fecha del último contacto real con el prospecto. */
    @Column({ type: 'date', nullable: true })
    lastContactAt: string;

    /**
     * Clave de la fila en el origen (hoja de cálculo o conversación) para no
     * duplicar en importaciones sucesivas. Solo es única dentro de un mismo
     * dueño: dos clientes pueden tener al mismo contacto sin pisarse.
     */
    @Column({ nullable: true })
    @Index()
    externalKey: string;

    /**
     * A quién pertenece el prospecto.
     *
     * Antes los leads eran una lista única y global: servía mientras el CRM
     * era solo del administrador, pero impedía que cada cliente viera los
     * suyos. Con dueño, cada cuenta trabaja su propio embudo y nadie ve el
     * de los demás.
     */
    @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
    @Index()
    owner: User;

    /** Cómo entró: 'manual' | 'sheets' */
    @Column({ type: 'varchar', length: 20, default: 'manual' })
    origin: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
