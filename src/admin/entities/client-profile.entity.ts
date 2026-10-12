import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToOne, JoinColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Extended business profile the agency keeps for each client account.
 * Billing fields (RUC, businessName) are the base for electronic
 * invoicing (SUNAT via OSE like Nubefact) in a later phase.
 */
@Entity('client_profiles')
export class ClientProfile {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @OneToOne(() => User)
    @JoinColumn()
    user: User;

    // ── Facturación (Perú) ──
    @Column({ nullable: true })
    ruc: string;

    @Column({ nullable: true })
    businessName: string; // razón social

    @Column({ nullable: true })
    fiscalAddress: string;

    // ── Relación comercial ──
    @Column({ type: 'varchar', length: 20, default: 'saas' })
    clientType: 'agency' | 'saas'; // cliente de agencia (retainer) o comprador del software

    @Column({ type: 'varchar', length: 20, default: 'activo' })
    status: 'activo' | 'pausado' | 'perdido';

    @Column({ nullable: true })
    contactName: string;

    @Column({ nullable: true })
    contactPhone: string;

    // ── Fuente de reportes externa (Google Sheets publicado como CSV) ──
    // Permite alimentar el reporte del cliente con los datos que hoy
    // viven en Sheets/AppScript, además de las órdenes de marketplaces.
    @Column({ nullable: true, type: 'text' })
    sheetCsvUrl: string;

    /**
     * Reporte externo del cliente (AppScript, Looker Studio, Sheets
     * publicado...) que se muestra embebido dentro de sus Analíticas.
     * Permite conservar los reportes históricos mientras el reporte
     * nativo se alimenta de los marketplaces.
     */
    @Column({ nullable: true, type: 'text' })
    reportEmbedUrl: string;

    /** Título de la pestaña del reporte embebido. */
    @Column({ nullable: true })
    reportEmbedTitle: string;

    // ── Plan comercial (qué se le cobra y cuándo) ──
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

    /** Cuándo le toca pagar la próxima cuota (YYYY-MM-DD). Avanza sola al registrar un pago recurrente. */
    @Column({ type: 'date', nullable: true })
    nextDueDate: string | null;

    @Column({ type: 'varchar', length: 5, default: 'PEN' })
    planCurrency: string;

    /** Apuntes de la propuesta comercial para este cliente. */
    @Column({ nullable: true, type: 'text' })
    proposalNotes: string | null;

    @Column({ nullable: true, type: 'text' })
    notes: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
