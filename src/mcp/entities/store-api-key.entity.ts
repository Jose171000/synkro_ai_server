import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Store } from '../../stores/entities/store.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Clave de acceso al MCP de UNA tienda (ver docs/mcp.md). La clave completa se muestra una sola vez al crearla; aquí solo se
 * guarda su hash (SHA-256) y un prefijo para reconocerla en la lista.
 *
 * Lo que la clave puede hacer es la INTERSECCIÓN de sus `permissions` y de los permisos que su creador tiene hoy en la tienda:
 * si a esa persona le quitan el rol o la sacan del equipo, la clave pierde poder en la siguiente llamada.
 */
@Entity('store_api_keys')
export class StoreApiKey {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** «store»: clave de UNA tienda (`/mcp`). «platform»: clave de un superadmin para toda la agencia (`/mcp/admin`), sin tienda. */
    @Column({ type: 'varchar', length: 10, default: 'store' })
    kind: 'store' | 'platform';

    /** Nula solo en las de plataforma (lo asegura un CHECK de la base). */
    @ManyToOne(() => Store, { onDelete: 'CASCADE', nullable: true })
    store: Store | null;

    /** Quien la creó: sus permisos actuales son el techo de la clave. */
    @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
    createdBy: User;

    @Column({ type: 'varchar', length: 60 })
    name: string;

    @Index({ unique: true })
    @Column({ type: 'varchar', length: 64 })
    keyHash: string;

    /** Los primeros caracteres de la clave, para reconocerla en la lista. Nunca bastan para usarla. */
    @Column({ type: 'varchar', length: 16 })
    prefix: string;

    @Column({ type: 'jsonb', default: () => "'[]'" })
    permissions: string[];

    @Column({ type: 'timestamptz', nullable: true })
    expiresAt: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    revokedAt: Date | null;

    @Column({ type: 'timestamptz', nullable: true })
    lastUsedAt: Date | null;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;
}
