import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * A payment received from a client — one-time or an installment of a
 * recurring plan. This is the source for the finance dashboard (MRR,
 * monthly income) and, later, for issuing electronic invoices.
 */
@Entity('payments')
export class Payment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => User, { nullable: false })
    @Index()
    client: User;

    @Column('decimal', { precision: 12, scale: 2 })
    amount: number;

    @Column({ type: 'varchar', length: 5, default: 'PEN' })
    currency: string;

    @Column({ type: 'varchar', length: 20 })
    type: 'unico' | 'recurrente';

    // Solo para recurrentes: mensual | trimestral | anual
    @Column({ type: 'varchar', length: 20, nullable: true })
    frequency: string;

    @Column()
    concept: string; // ej. "Retainer agencia julio", "Licencia Synkro App"

    @Column({ type: 'varchar', length: 30, nullable: true })
    method: string; // transferencia | yape | plin | tarjeta | efectivo

    @Column({ type: 'date' })
    paidAt: string;

    // Comprobante (fase SUNAT/OSE): correlativo o referencia externa
    @Column({ nullable: true })
    receiptRef: string;

    @Column({ nullable: true, type: 'text' })
    notes: string;

    @CreateDateColumn()
    createdAt: Date;
}
