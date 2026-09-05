import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Unique } from 'typeorm';
import { Product } from 'src/products/entities/product.entity';

/**
 * Links an internal product with the listing actually published on a
 * marketplace (e.g. Mercado Libre item MLA123456). This is the source
 * of truth for what is live on each channel and its sync state.
 */
@Entity('listing_links')
@Unique('UQ_listing_product_marketplace', ['product', 'marketplace'])
export class ListingLink {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    marketplace: string; // 'mercadolibre' | 'shopify' | 'amazon'

    // ID of the listing on the external platform (e.g. 'MLA123456')
    @Column()
    externalId: string;

    @Column({ nullable: true })
    permalink: string;

    @Column({ default: 'pending' })
    syncStatus: 'pending' | 'published' | 'paused' | 'error';

    // Last stock/price values pushed to the marketplace
    @Column({ nullable: true })
    lastStockSynced: number;

    @Column('decimal', { precision: 10, scale: 2, nullable: true })
    lastPriceSynced: number;

    /**
     * Nota de calidad de la ficha, de 0 a 100, tal como la califica el canal.
     *
     * Falabella la devuelve en `ContentScore`. Es la medida de optimización
     * que hasta ahora se llevaba a mano en una hoja de cálculo, y viene del
     * propio canal en vez de estimarse. Nula cuando el canal no la publica.
     */
    @Column('int', { nullable: true })
    qualityScore: number | null;

    @Column({ type: 'timestamptz', nullable: true })
    lastSyncedAt: Date;

    @Column('text', { nullable: true })
    lastError: string;

    @ManyToOne(() => Product, { onDelete: 'CASCADE' })
    product: Product;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
