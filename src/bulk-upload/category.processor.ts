import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketplaceCategory } from '../categories/entities/marketplace-category.entity';
import { CategorySeederService } from '../categories/category-seeder.service';

export interface CategoryJobData {
    marketplace: string;
    categoryId: string;
    name: string;
    labelText: string;
    requiredAttributes?: any[];
}

/**
 * BullMQ worker for bulk category seeding.
 * Concurrency 5 keeps OpenAI embedding calls well within the default RPM limit.
 */
@Processor('category-seed-queue', { concurrency: 5 })
export class CategoryProcessor extends WorkerHost {
    constructor(
        @InjectRepository(MarketplaceCategory)
        private readonly categoryRepository: Repository<MarketplaceCategory>,
        private readonly categorySeederService: CategorySeederService,
    ) {
        super();
    }

    async process(job: Job<CategoryJobData>): Promise<any> {
        const { marketplace, categoryId, name, labelText, requiredAttributes } = job.data;
        const tag = `[${marketplace.toUpperCase()}] ${name}`;

        try {
            // 1. Skip duplicates — the unique constraint would reject anyway, but skip early
            const existing = await this.categoryRepository.findOne({
                where: { categoryId, marketplace: marketplace.toLowerCase() },
            });
            if (existing) {
                console.log(`[CategoryProcessor] ⏭ Skipped duplicate: ${tag}`);
                return { status: 'skipped', categoryId };
            }

            // 2. Generate embedding via CategorySeederService (uses Redis cache)
            const embedding = await this.categorySeederService.generateEmbedding(labelText);

            // 3. Save to DB
            const entity = this.categoryRepository.create({
                marketplace: marketplace.toLowerCase(),
                categoryId,
                name,
                labelText,
                requiredAttributes: requiredAttributes ?? [],
                embedding,
            });
            await this.categoryRepository.save(entity);

            console.log(`[CategoryProcessor] ✓ Saved: ${tag}`);
            return { status: 'created', categoryId };
        } catch (error) {
            console.error(`[CategoryProcessor] ✗ Failed: ${tag} →`, error.message);
            // Re-throw so BullMQ marks the job as failed and can retry
            throw error;
        }
    }
}
