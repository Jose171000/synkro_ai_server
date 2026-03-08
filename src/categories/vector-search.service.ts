import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketplaceCategory } from './entities/marketplace-category.entity';

@Injectable()
export class VectorSearchService {
    constructor(
        @InjectRepository(MarketplaceCategory)
        private categoryRepository: Repository<MarketplaceCategory>,
    ) { }

    /**
     * Finds the top N most semantically similar categories using PostgreSQL's native
     * pgvector <=> cosine distance operator — fully delegated to the database engine.
     *
     * @param queryEmbedding - The embedding vector of the product being categorized
     * @param marketplace    - Filter results by marketplace (e.g., 'amazon', 'mercadolibre')
     * @param topN           - How many top results to return (default: 5)
     */
    async findSimilarCategories(
        queryEmbedding: number[],
        marketplace: string,
        topN = 5,
    ): Promise<MarketplaceCategory[]> {
        // Format the query vector in pgvector wire format: [n1,n2,...]
        const vectorLiteral = `[${queryEmbedding.join(',')}]`;

        // Use raw SQL to leverage the native <=> cosine distance operator.
        // This is far more efficient than loading all rows to TypeScript —
        // PostgreSQL evaluates similarity directly and returns only the top N rows.
        // With an HNSW index this becomes an approximate O(log n) query.
        const rows: any[] = await this.categoryRepository.query(
            `SELECT
                id,
                marketplace,
                "categoryId",
                name,
                "labelText",
                "requiredAttributes",
                embedding::text,
                "createdAt",
                "updatedAt",
                (embedding <=> $1::vector) AS distance
             FROM marketplace_categories
             WHERE marketplace = $2
               AND embedding IS NOT NULL
             ORDER BY distance ASC
             LIMIT $3`,
            [vectorLiteral, marketplace.toLowerCase(), topN],
        );

        if (rows.length === 0) {
            console.warn(`[VectorSearch] No categories found in DB for marketplace: ${marketplace}`);
            return [];
        }

        // Map raw rows back to MarketplaceCategory instances
        // (the transformer on the entity isn't invoked for raw queries)
        return rows.map(row => {
            const entity = new MarketplaceCategory();
            entity.id = row.id;
            entity.marketplace = row.marketplace;
            entity.categoryId = row.categoryId;
            entity.name = row.name;
            entity.labelText = row.labelText;
            entity.requiredAttributes = row.requiredAttributes;
            entity.createdAt = row.createdAt;
            entity.updatedAt = row.updatedAt;
            // Parse the embedding text back to number[] (same as the column transformer)
            entity.embedding = row.embedding
                ? row.embedding.slice(1, -1).split(',').map(Number)
                : null;
            return entity;
        });
    }
}
