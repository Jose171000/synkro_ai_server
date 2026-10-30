import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany } from "typeorm";
import { User } from "src/users/entities/user.entity";
import { Store } from "../../stores/entities/store.entity";
import { ProductImage } from "./product-image.entity";
import { ProductGroup } from "./product-group.entity";

// Unicidad del SKU: índices únicos por tienda (sin distinguir mayúsculas ni espacios) creados por SkuUnicoService.
@Entity('products')
export class Product {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column()
    sku: string;

    @Column('text')
    description: string;

    // Campos generados por IA
    @Column({ nullable: true })
    aiTitle: string;

    @Column('text', { nullable: true })
    aiDescription: string;

    @Column('simple-array', { nullable: true })
    aiKeywords: string[];

    @Column({ type: 'jsonb', nullable: true })
    aiAttributes: Record<string, any>;

    // Categorización
    @Column({ nullable: true })
    category: string;

    @Column({ nullable: true })
    subCategory: string;

    // Precio e inventario
    @Column('decimal', { precision: 10, scale: 2, nullable: true })
    price: number;

    @Column({ default: 0 })
    stock: number;

    /**
     * Precio con descuento de la tienda web propia (futura conexión con
     * WooCommerce). No se envía a ningún marketplace: es solo del canal web.
     */
    @Column('decimal', { precision: 10, scale: 2, nullable: true })
    webPrice: number | null;

    /**
     * Promoción en los marketplaces (hoy Falabella): precio con descuento y fechas de vigencia («AAAA-MM-DD»).
     * Distinto del precio web, que es solo de la tienda propia.
     */
    @Column('decimal', { precision: 10, scale: 2, nullable: true })
    salePrice: number | null;

    @Column('date', { nullable: true })
    saleStartDate: string | null;

    @Column('date', { nullable: true })
    saleEndDate: string | null;

    // ── Datos de envío ───────────────────────────────────────────
    // Falabella los exige para publicar (alto, ancho, largo en cm y peso en
    // kg). Son nulos por defecto porque los productos antiguos no los tienen;
    // publicar sin ellos se rechaza con un aviso, en vez de mandar medidas
    // inventadas que afectarían el costo de envío real del comprador.
    @Column('int', { nullable: true })
    packageWidth: number | null;

    @Column('int', { nullable: true })
    packageLength: number | null;

    @Column('int', { nullable: true })
    packageHeight: number | null;

    @Column('decimal', { precision: 8, scale: 3, nullable: true })
    packageWeight: number | null;

    // Imágenes
    @OneToMany(() => ProductImage, (productImage) => productImage.product, { cascade: true, eager: true })
    images: ProductImage[];

    // Marketplace sincronizados
    // @Column('jsonb', { nullable: true })
    // marketplaceIds: Record<string, string>;  // { mercadolibre: 'MLA123', amazon: 'ASIN456' }

    @Column({ type: 'jsonb', nullable: true })
    marketplaceIds: Record<string, string>;


    @Column('simple-array', { nullable: true })
    targetMarketplaces: string[]; // ['mercadolibre', 'amazon']

    /** Canal del que se importó el producto (falabella, mercadolibre…). Nulo si se creó en Synkro. */
    @Column({ type: 'varchar', nullable: true })
    importedFrom: string | null;

    // Estado
    @Column({ default: 'draft' })
    status: 'draft' | 'pending' | 'synced' | 'error';

    @ManyToOne(() => User)
    owner: User;

    /** Tienda a la que pertenece el producto. Nulo en productos aún sin asignar. */
    @ManyToOne(() => Store, { onDelete: 'SET NULL', nullable: true })
    store: Store | null;

    /** Grupo de variantes al que pertenece. Nulo en un producto simple. */
    @ManyToOne(() => ProductGroup, (group) => group.variants, { onDelete: 'SET NULL', nullable: true })
    group: ProductGroup | null;

    /** Valores de esta variante en cada eje del grupo, ej. {Color:'Rojo', Talla:'M'}. */
    @Column({ type: 'jsonb', nullable: true })
    variantValues: Record<string, string> | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

}