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

    @Column({ nullable: true, type: 'text' })
    notes: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
