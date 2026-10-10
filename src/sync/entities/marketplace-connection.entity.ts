import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Unique } from 'typeorm';
import { User } from 'src/users/entities/user.entity';
import { Store } from '../../stores/entities/store.entity';
import { encryptedJsonTransformer, encryptedTextTransformer } from '../../common/crypto/encrypted-column.transformer';

/**
 * Stores the credentials that link a Synkro user with their seller account on
 * an external marketplace (Mercado Libre, Yavendió, Falabella...).
 * Una fila por cuenta del canal dentro de una tienda: una tienda admite hasta
 * 3 cuentas del mismo marketplace.
 *
 * Todo lo que sea secreto se guarda CIFRADO en la base de datos: las columnas
 * marcadas con un transformador se cifran al escribir y se descifran al leer,
 * de forma transparente para el resto del código.
 */
@Entity('marketplace_connections')
@Unique('UQ_connection_store_marketplace_account', ['store', 'marketplace', 'externalUserId'])
export class MarketplaceConnection {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    marketplace: string; // 'mercadolibre' | 'yavendio' | 'falabella'

    /** La tienda a la que pertenece esta cuenta conectada. */
    @ManyToOne(() => Store, { onDelete: 'CASCADE', nullable: true })
    store: Store | null;

    /** Nombre con el que la tienda distingue esta cuenta de otras del mismo canal. */
    @Column({ type: 'varchar', nullable: true })
    label: string | null;

    // Seller ID on the external platform (e.g. Mercado Libre user id).
    // No es un secreto y se busca por él cuando llega un webhook, así que
    // se queda en claro: cifrarlo impediría consultarlo.
    @Column()
    externalUserId: string;

    @Column({ nullable: true })
    externalNickname: string;

    @Column('text', { transformer: encryptedTextTransformer })
    accessToken: string;

    @Column('text', { nullable: true, transformer: encryptedTextTransformer })
    refreshToken: string;

    /**
     * Credenciales adicionales que no encajan en el modelo OAuth: la API key
     * de Yavendió, el par UserID + API key de Falabella, etc. Se guarda como
     * un único bloque JSON cifrado.
     */
    @Column('text', { nullable: true, transformer: encryptedJsonTransformer })
    secrets: Record<string, any> | null;

    /**
     * Cuándo deja de valer el accessToken. Nulo cuando la credencial no
     * caduca: las API keys de Yavendió o Falabella viven hasta que el
     * cliente las revoca a mano.
     */
    @Column({ type: 'timestamptz', nullable: true })
    expiresAt: Date | null;

    /**
     * Moneda en la que vende esta cuenta (ISO 4217: PEN, COP, CLP...).
     *
     * Se guarda al conectar porque no todos los marketplaces la dicen en cada
     * pedido: Falabella opera en Perú, Chile y Colombia con la misma API, así
     * que sin este dato un cliente colombiano tendría sus ventas guardadas en
     * soles. Nula significa "usa la de por defecto de la instalación".
     */
    @Column({ type: 'varchar', length: 5, nullable: true })
    currency: string | null;

    @Column({ default: 'active' })
    status: 'active' | 'revoked' | 'error';

    @ManyToOne(() => User)
    owner: User;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
