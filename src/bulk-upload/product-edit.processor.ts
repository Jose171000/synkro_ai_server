import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { BatchNotificationService, BatchMeta } from './batch-notification.service';

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
    // Batch tracking (optional — only present on bulk upload jobs)
    batchId?: string;
    batchTotal?: number;
    userEmail?: string;
}

/**
 * BullMQ worker for bulk product editing.
 * Concurrency 10 — pure DB writes, no external API calls.
 */
@Processor('product-edit-queue', { concurrency: 10 })
export class ProductEditProcessor extends WorkerHost {
    constructor(
        @InjectRepository(Product)
        private readonly productRepository: Repository<Product>,
        private readonly batchNotification: BatchNotificationService,
    ) {
        super();
    }

    async process(job: Job<ProductEditJobData>): Promise<any> {
        const { sku, userId, batchId, batchTotal, userEmail, ...updates } = job.data;

        const batchMeta: BatchMeta | undefined = batchId ? {
            batchId,
            batchTotal: batchTotal!,
            userEmail:  userEmail!,
            jobType:    'Edición masiva de productos',
        } : undefined;

        try {
            const product = await this.productRepository.findOne({
                where: { sku, owner: { id: userId } },
            });

            if (!product) {
                console.warn(`[ProductEditProcessor] SKU "${sku}" not found for user ${userId} — skipped.`);
                if (batchMeta) await this.batchNotification.trackAndNotify(batchMeta, true); // count as done
                return { status: 'skipped', sku };
            }

            if (updates.name              !== undefined) product.name              = updates.name;
            if (updates.description       !== undefined) product.description       = updates.description;
            if (updates.price             !== undefined) product.price             = updates.price;
            if (updates.stock             !== undefined) product.stock             = updates.stock;
            if (updates.category          !== undefined) product.category          = updates.category;
            if (updates.subCategory       !== undefined) product.subCategory       = updates.subCategory;
            if (updates.targetMarketplaces !== undefined) product.targetMarketplaces = updates.targetMarketplaces;

            await this.productRepository.save(product);
            console.log(`[ProductEditProcessor] ✓ Updated SKU "${sku}" (id: ${product.id})`);

            if (batchMeta) await this.batchNotification.trackAndNotify(batchMeta, true);
            return { status: 'updated', productId: product.id, sku };
        } catch (error) {
            console.error(`[ProductEditProcessor] Job ${job.id} failed:`, error);
            if (batchMeta) await this.batchNotification.trackAndNotify(batchMeta, false);
            throw error;
        }
    }
}
