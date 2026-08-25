import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Index, Unique } from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Liquidación mensual de un cliente que paga un porcentaje sobre sus
 * ventas. Guarda las ventas del periodo, el % pactado y la comisión
 * resultante, más el estado de facturación para que el contador sepa
 * a quién emitirle factura.
 */
@Entity('monthly_billings')
@Unique('UQ_billing_client_period', ['client', 'period'])
export class MonthlyBilling {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => User, { nullable: false })
    @Index()
    client: User;

    /** Periodo liquidado en formato YYYY-MM. */
    @Column({ type: 'varchar', length: 7 })
    @Index()
    period: string;

    @Column('decimal', { precision: 14, scale: 2, default: 0 })
    totalSales: number;

    /** Porcentaje pactado sobre las ventas (ej. 8.5 = 8.5%). */
    @Column('decimal', { precision: 6, scale: 3, default: 0 })
    commissionRate: number;

    /** Comisión calculada; se guarda para que el histórico no cambie
     *  si algún día se corrige el porcentaje pactado. */
    @Column('decimal', { precision: 14, scale: 2, default: 0 })
    commissionAmount: number;

    @Column({ type: 'varchar', length: 5, default: 'PEN' })
    currency: string;

    @Column({ type: 'varchar', length: 20, default: 'pendiente' })
    status: 'pendiente' | 'facturado' | 'cobrado';

    /** Número o referencia del comprobante emitido. */
    @Column({ nullable: true })
    invoiceRef: string;

    @Column({ type: 'date', nullable: true })
    invoicedAt: string;

    /** De dónde salieron las ventas: manual | sheets | marketplaces */
    @Column({ type: 'varchar', length: 20, default: 'manual' })
    salesSource: string;

    @Column({ type: 'text', nullable: true })
    notes: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
