import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketplaceCategory } from '../categories/entities/marketplace-category.entity';
import { CategorySeederService } from '../categories/category-seeder.service';

export interface CategoryEditJobData {
    categoryId: string;
    marketplace: string;
    name?: string;
    labelText?: string;
    requiredAttributes?: any[];
}

/**
 * BullMQ worker for bulk category editing (admin-only use).
 * Concurrency 5 — may call OpenAI when labelText changes (uses Redis cache).
 */
@Processor('category-edit-queue', { concurrency: 5 })
export class CategoryEditProcessor extends WorkerHost {
    constructor(
        @InjectRepository(MarketplaceCategory)
        private readonly categoryRepository: Repository<MarketplaceCategory>,
        private readonly categorySeederService: CategorySeederService,
    ) {
        super();
    }

    async process(job: Job<CategoryEditJobData>): Promise<any> {
        const { categoryId, marketplace, ...updates } = job.data;
        const tag = `[${marketplace.toUpperCase()}] ${categoryId}`;

        const category = await this.categoryRepository.findOne({
            where: { categoryId, marketplace: marketplace.toLowerCase() },
        });

        if (!category) {
            console.warn(`[CategoryEditProcessor] Category ${tag} not found — skipped.`);
            return { status: 'skipped', categoryId, marketplace };
        }

        let regeneratedEmbedding = false;

        // Apply provided updates
        if (updates.name !== undefined) category.name = updates.name;
        if (updates.requiredAttributes !== undefined) category.requiredAttributes = updates.requiredAttributes;

        // Regenerate embedding only when labelText actually changes
        if (updates.labelText !== undefined && updates.labelText !== category.labelText) {
            category.labelText = updates.labelText;
            category.embedding = await this.categorySeederService.generateEmbedding(updates.labelText);
            regeneratedEmbedding = true;
        }

        await this.categoryRepository.save(category);
        console.log(`[CategoryEditProcessor] ✓ Updated category ${tag}${regeneratedEmbedding ? ' (embedding regenerated)' : ''}`);
        return { status: 'updated', categoryId, marketplace, regeneratedEmbedding };
    }
}
