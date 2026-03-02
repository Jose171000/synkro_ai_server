import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('marketplace_categories')
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

    // Mandatory fields this category requires on listings (e.g. ['ShoeSize', 'Color'])
    @Column({ type: 'jsonb', nullable: true })
    requiredAttributes: string[];

    // The pgvector embedding stored as float array - 1536 dims for text-embedding-3-small
    @Column({ type: 'text', nullable: true })
    embedding: string; // stored as JSON string "[0.12, -0.44, ...]"

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
