import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Store } from '../../stores/entities/store.entity';

/**
 * Registro de cada escritura hecha por el MCP: qué clave, qué herramienta, sobre qué y cómo terminó. Se anota ANTES de
 * ejecutar: sin registro no se escribe. Los ids de clave y usuario van sueltos para que el historial no desaparezca con ellos.
 */
@Entity('mcp_write_log')
export class McpWriteLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index('IDX_mcp_write_log_store')
    @Column({ type: 'uuid' })
    storeId: string;

    /** Solo para que la base borre el historial junto con la tienda; se consulta por `storeId`. */
    @ManyToOne(() => Store, { onDelete: 'CASCADE', nullable: false })
    @JoinColumn({ name: 'storeId', foreignKeyConstraintName: 'FK_mcp_write_log_store' })
    store?: Store;

    @Column({ type: 'uuid' })
    keyId: string;

    @Column({ length: 60 })
    keyName: string;

    @Column({ type: 'uuid' })
    userId: string;

    @Column({ length: 60 })
    tool: string;

    /** Lo justo para reconocer el cambio (nombre, SKU, ids): nunca la petición completa. */
    @Column({ type: 'jsonb', default: {} })
    resumen: Record<string, unknown>;

    @Column({ type: 'varchar', length: 10, default: 'pendiente' })
    estado: 'pendiente' | 'hecho' | 'error';

    @Column({ type: 'varchar', length: 500, nullable: true })
    mensaje: string | null;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;
}
