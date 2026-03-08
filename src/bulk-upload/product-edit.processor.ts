import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';

export interface ProductEditJobData {
    sku: string;
    userId: string;
    name?: string;
    description?: string;
    price?: number;
    stock?: number;
    category?: string;
    subCategory?: string;
    targetMarketplaces?: string[];
}

/**
 * BullMQ worker for bulk product editing.
 * Concurrency 10 — pure DB writes, no external API calls.
 * Finds product by (sku + userId) to enforce ownership.
 */
@Processor('product-edit-queue', { concurrency: 10 })
export class ProductEditProcessor extends WorkerHost {
    constructor(
        @InjectRepository(Product)
        private readonly productRepository: Repository<Product>,
    ) {
        super();
    }

    async process(job: Job<ProductEditJobData>): Promise<any> {
        const { sku, userId, ...updates } = job.data;

        const product = await this.productRepository.findOne({
            where: { sku, owner: { id: userId } },
        });

        if (!product) {
            // Not an error — the SKU just doesn't belong to this user; skip silently
            console.warn(`[ProductEditProcessor] SKU "${sku}" not found for user ${userId} — skipped.`);
            return { status: 'skipped', sku };
        }

        // Apply only the fields that were provided (partial update)
        if (updates.name !== undefined) product.name = updates.name;
        if (updates.description !== undefined) product.description = updates.description;
        if (updates.price !== undefined) product.price = updates.price;
        if (updates.stock !== undefined) product.stock = updates.stock;
        if (updates.category !== undefined) product.category = updates.category;
        if (updates.subCategory !== undefined) product.subCategory = updates.subCategory;
        if (updates.targetMarketplaces !== undefined) product.targetMarketplaces = updates.targetMarketplaces;

        await this.productRepository.save(product);
        console.log(`[ProductEditProcessor] ✓ Updated product SKU "${sku}" (id: ${product.id})`);
        return { status: 'updated', productId: product.id, sku };
    }
}
