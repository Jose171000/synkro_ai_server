import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Index } from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Una tienda: la unidad a la que pertenecen las conexiones con canales y el
 * Ojo de Dios. Una cuenta puede crear varias, y otras personas entran a ellas
 * solo por invitación (ver StoreMember).
 */
@Entity('stores')
export class Store {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    /** Quien la creó. Es su dueño y el único que puede invitar o quitar gente. */
    @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
    @Index()
    owner: User;

    // ── Plan comercial: cada tienda es un cliente de la agencia ──
    /** Cómo se le cobra: cuota fija, comisión sobre sus ventas, ambos o nada definido. */
    @Column({ type: 'varchar', length: 20, default: 'ninguno' })
    billingModel: 'ninguno' | 'fijo' | 'comision' | 'mixto';

    /** Cuota pactada, por periodo de la frecuencia. */
    @Column('decimal', { precision: 12, scale: 2, nullable: true, transformer: { to: (v: any) => v, from: (v: any) => (v === null || v === undefined ? null : Number(v)) } })
    monthlyFee: number | null;

    @Column({ type: 'varchar', length: 20, default: 'mensual' })
    feeFrequency: 'mensual' | 'trimestral' | 'anual';

    /** Porcentaje sobre sus ventas (8.5 = 8.5%). */
    @Column('decimal', { precision: 6, scale: 3, nullable: true, transformer: { to: (v: any) => v, from: (v: any) => (v === null || v === undefined ? null : Number(v)) } })
    commissionRate: number | null;

    /** Cuándo toca el próximo cobro (YYYY-MM-DD). Avanza sola al registrar un pago recurrente. */
    @Column({ type: 'date', nullable: true })
    nextDueDate: string | null;

    @Column({ type: 'varchar', length: 5, default: 'PEN' })
    planCurrency: string;

    /** true: la cuota pactada ya incluye IGV. false: el IGV se suma aparte. */
    @Column({ default: false })
    feeIncludesIgv: boolean;

    /** true: la comisión pactada ya incluye IGV. false: el IGV se suma aparte. */
    @Column({ default: false })
    commissionIncludesIgv: boolean;

    /** Desde cuándo rige el plan: si es posterior al inicio del ciclo, las ventas se cuentan desde aquí. */
    @Column({ type: 'date', nullable: true })
    planStartDate: string | null;

    /** Apuntes de la propuesta comercial para este cliente. */
    @Column({ type: 'text', nullable: true })
    proposalNotes: string | null;

    /**
     * Código del enlace público de solo lectura. Largo y aleatorio, nunca el
     * nombre ni el id de la tienda, para que no se pueda recorrer probando
     * tiendas. Nulo mientras el enlace no se haya activado.
     */
    @Column({ type: 'varchar', nullable: true, unique: true })
    publicToken: string | null;

    /** El enlace público solo responde si está activado. */
    @Column({ default: false })
    publicEnabled: boolean;

    /**
     * Modo revisión de la tienda: los cambios de precio y stock esperan
     * aprobación del dueño antes de llegar a los canales.
     */
    @Column({ default: true })
    syncReviewMode: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
