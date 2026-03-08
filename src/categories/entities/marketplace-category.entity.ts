import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Unique } from 'typeorm';

// Describes a single required attribute for a marketplace category listing
export interface CategoryAttribute {
    name: string;         // e.g. "ShoeSize"
    description: string;  // e.g. "Talla del calzado en sistema US, número decimal"
    example: string;      // e.g. "10.5"
    isRequired: boolean;  // true = obligatorio en el listing, false = recomendado/opcional
}

@Entity('marketplace_categories')
@Unique('UQ_category_marketplace', ['categoryId', 'marketplace'])
export class MarketplaceCategory {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    // e.g. 'amazon', 'mercadolibre'
    @Column()
    marketplace: string;

    // The native category ID of the marketplace (e.g. 'MLA2001', 'shoes_athletic')
    @Column()
    categoryId: string;

    // Human-readable name (e.g. 'Zapatillas deportivas')
    @Column()
    name: string;

    // Text optimized for embedding (richer keywords for semantic search)
    @Column('text')
    labelText: string;

    // Mandatory fields this category requires, with descriptions and examples for the LLM
    @Column({ type: 'jsonb', nullable: true })
    requiredAttributes: CategoryAttribute[];

    // Semantic embedding vector — 1536 dimensions (text-embedding-3-small)
    // Stored as 'text' in TypeORM (TypeORM rejects 'vector' via its internal type whitelist).
    // The raw SQL queries in VectorSearchService cast to ::vector so pgvector operators
    // (<=> cosine distance, HNSW indexes) work correctly at the PostgreSQL level.
    @Column({
        type: 'text',
        nullable: true,
        transformer: {
            to: (value: number[] | null): string | null => {
                if (!value) return null;
                return `[${value.join(',')}]`; // pgvector wire format
            },
            from: (value: string | null): number[] | null => {
                if (!value) return null;
                return value.slice(1, -1).split(',').map(Number);
            },
        },
    })
    embedding: number[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
