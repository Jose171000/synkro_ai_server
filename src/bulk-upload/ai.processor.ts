import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AiService } from '../ai/ai.service';
import { ProductsService } from '../products/products.service';
import { InternalServerErrorException } from '@nestjs/common';
import { BatchNotificationService, BatchMeta } from './batch-notification.service';

@Processor('generate-listings-queue')
export class AiProcessor extends WorkerHost {
    constructor(
        private readonly aiService: AiService,
        private readonly productsService: ProductsService,
        private readonly batchNotification: BatchNotificationService,
    ) {
        super();
    }

    async process(job: Job<any, any, string>): Promise<any> {
        console.log(`[AiProcessor] Processing job ${job.id} for product: ${job.data.productName}`);

        const { sku, productName, description, targetMarketplaces, userId, imageUrl } = job.data;

        const batchMeta: BatchMeta | undefined = job.data.batchId ? {
            batchId:    job.data.batchId,
            batchTotal: job.data.batchTotal,
            userEmail:  job.data.userEmail,
            jobType:    'Creación masiva de productos',
        } : undefined;

        try {
            // 1. Create the product with the resolved image URL (if any)
            const product = await this.productsService.create({
                name: productName,
                description,
                sku,
                targetMarketplaces,
                images: imageUrl ? [imageUrl] : [],
            }, userId);

            // 2. Generate AI content (Phase A + Phase B)
            const aiContent = await this.aiService.generateProductContent({
                name: productName,
                description,
                targetMarketplaces,
            });

            // 3. Map DeepSeek results to DB schema
            const firstMarketplaceData = Object.values(aiContent.generatedListings || aiContent)[0] as any;

            if (firstMarketplaceData) {
                product.aiTitle       = firstMarketplaceData.title       || product.aiTitle;
                product.aiDescription = firstMarketplaceData.description || product.aiDescription;

                const bulletPoints = typeof firstMarketplaceData.bullet_points === 'string'
                    ? [firstMarketplaceData.bullet_points]
                    : firstMarketplaceData.bullet_points;

                product.aiKeywords   = bulletPoints || product.aiKeywords;
                product.aiAttributes = typeof firstMarketplaceData.attributes === 'object'
                    ? firstMarketplaceData.attributes
                    : (typeof firstMarketplaceData === 'object' ? firstMarketplaceData : product.aiAttributes);
            }

            if (aiContent.categorizedAs) {
                product.marketplaceIds = aiContent.categorizedAs;
            }

            product.status = 'synced';
            const updatedProduct = await this.productsService.save(product);

            console.log(`[AiProcessor] ✓ Job ${job.id} done -> Product ${updatedProduct.id}`);

            // Track batch progress — notify user when all jobs in this upload are done
            if (batchMeta) await this.batchNotification.trackAndNotify(batchMeta, true);

            return { status: 'completed', productId: updatedProduct.id };
        } catch (error) {
            console.error(`[AiProcessor] Job ${job.id} failed:`, error);

            // Track failed job too — batch must still complete
            if (batchMeta) await this.batchNotification.trackAndNotify(batchMeta, false);

            throw new InternalServerErrorException('Error processing AI background job');
        }
    }
}
