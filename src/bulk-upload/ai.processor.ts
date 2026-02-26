import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AiService } from '../ai/ai.service';
import { ProductsService } from '../products/products.service';
import { InternalServerErrorException } from '@nestjs/common';

@Processor('generate-listings-queue')
export class AiProcessor extends WorkerHost {
    constructor(
        private readonly aiService: AiService,
        private readonly productsService: ProductsService,
    ) {
        super();
    }

    async process(job: Job<any, any, string>): Promise<any> {
        console.log(`[AiProcessor] Processing job ${job.id} for product: ${job.data.productName}`);

        const { sku, productName, description, targetMarketplaces, userId } = job.data;

        try {
            // 1. Create the product immediately in a 'pending' state
            const product = await this.productsService.create({
                name: productName,
                description,
                sku: sku,
                targetMarketplaces,
                images: []
            }, userId);

            // 2. Call AiService to orchestrate Phase A and Phase B
            const aiContent = await this.aiService.generateProductContent({
                name: productName,
                description,
                targetMarketplaces
            });

            // 3. Map the DeepSeek results to our local DB schema structure
            const firstMarketplaceData = Object.values(aiContent.generatedListings || aiContent)[0] as any;

            if (firstMarketplaceData) {
                product.aiTitle = firstMarketplaceData.title || product.aiTitle;
                product.aiDescription = firstMarketplaceData.description || product.aiDescription;

                const bulletPoints = typeof firstMarketplaceData.bullet_points === 'string'
                    ? [firstMarketplaceData.bullet_points]
                    : firstMarketplaceData.bullet_points;

                product.aiKeywords = bulletPoints || product.aiKeywords;

                product.aiAttributes = typeof firstMarketplaceData.attributes === 'object'
                    ? firstMarketplaceData.attributes
                    : (typeof firstMarketplaceData === 'object' ? firstMarketplaceData : product.aiAttributes);
            }

            // Also save the category assignments from Phase A
            if (aiContent.categorizedAs) {
                // Storing the RAW category mapping dict in our marketplaceIds JSON field just as proof of concept
                product.marketplaceIds = aiContent.categorizedAs;
            }

            // Mark the product as processed properly
            product.status = 'synced'; // "synced" since both Ai generation passes were done correctly

            const updatedProduct = await this.productsService.save(product);

            console.log(`[AiProcessor] Successfully finished job ${job.id} -> Saved Product ${updatedProduct.id}`);
            return { status: 'completed', productId: updatedProduct.id };
        } catch (error) {
            console.error(`[AiProcessor] Job ${job.id} failed:`, error);
            throw new InternalServerErrorException('Error processing AI background job');
        }
    }
}
