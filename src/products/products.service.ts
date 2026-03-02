import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { ProductImage } from './entities/product-image.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductWithAiDto } from './dto/create-product-with-ai.dto';
import { AiService } from 'src/ai/ai.service';

@Injectable()
export class ProductsService {
    constructor(
        @InjectRepository(Product)
        private productRepository: Repository<Product>,
        private aiService: AiService,
    ) { }

    async create(createProductDto: CreateProductDto, userId: string) {
        const { images = [], ...productDetails } = createProductDto;

        // Check for duplicate SKU within same user
        const existing = await this.productRepository.findOne({
            where: { sku: createProductDto.sku, owner: { id: userId } },
        });
        if (existing) {
            throw new ConflictException(
                `El SKU "${createProductDto.sku}" ya está en uso por el producto "${existing.name}". Por favor usa un SKU diferente.`
            );
        }

        const product = this.productRepository.create({
            ...productDetails,
            owner: { id: userId },
            images: images.map(url => this.productRepository.manager.create(ProductImage, { url }))
        });
        return this.productRepository.save(product);
    }

    async findAll(userId: string) {
        return this.productRepository.find({
            where: { owner: { id: userId } },
            order: { createdAt: 'DESC' },
        });
    }

    async findOne(id: string, userId: string) {
        const product = await this.productRepository.findOne({
            where: { id, owner: { id: userId } },
        });
        if (!product) {
            throw new NotFoundException('Producto no encontrado');
        }
        return product;
    }

    async generateAIContent(productId: string, userId: string, options?: { tone?: string; marketplaces?: string[] }) {
        const product = await this.findOne(productId, userId);

        const aiContent = await this.aiService.generateProductContent({
            name: product.name,
            description: product.description,
            category: product.category,
            subcategory: product.subCategory,
            targetMarketplaces: options?.marketplaces || product.targetMarketplaces || ['amazon', 'mercadolibre'],
            tone: options?.tone || 'professional',
        });

        // El backend de DeepSeek envía la resputesta anidada por marketplace (e.g. { amazon: { title: "..." }, mercadolibre: {...} }
        // Para simplificar la demo, guardaremos el payload completo de la IA como un JSON string en un campo genérico si lo deseas, 
        // o mapearemos el primer marketplace devuelto a los campos genéricos del producto.
        const firstMarketplaceData = Object.values(aiContent)[0] as any;

        if (firstMarketplaceData) {
            product.aiTitle = firstMarketplaceData.title || product.aiTitle;
            product.aiDescription = firstMarketplaceData.description || product.aiDescription;
            const bulletPoints = typeof firstMarketplaceData.bullet_points === 'string'
                ? [firstMarketplaceData.bullet_points]
                : firstMarketplaceData.bullet_points;

            product.aiKeywords = bulletPoints || product.aiKeywords;

            // The entity uses a transformer so we can assign an object directly
            product.aiAttributes = typeof firstMarketplaceData.attributes === 'object'
                ? firstMarketplaceData.attributes
                : (typeof firstMarketplaceData === 'object' ? firstMarketplaceData : product.aiAttributes);
        }

        return this.productRepository.save(product);
    }

    async createWithAI(dto: CreateProductWithAiDto, userId: string) {
        // Step 1: Check for duplicate SKU within same user BEFORE calling DeepSeek
        const existing = await this.productRepository.findOne({
            where: { sku: dto.sku, owner: { id: userId } },
        });
        if (existing) {
            throw new ConflictException(
                `El SKU "${dto.sku}" ya está en uso por el producto "${existing.name}". Por favor usa un SKU diferente.`
            );
        }

        const { tone, targetMarketplaces, images = [], ...productDetails } = dto;

        const product = this.productRepository.create({
            ...productDetails,
            owner: { id: userId },
            images: images.map(url => this.productRepository.manager.create(ProductImage, { url })),
            status: 'pending',
        });
        const savedProduct = await this.productRepository.save(product);

        // Step 2: Call DeepSeek (Phase A + Phase B)
        const aiContent = await this.aiService.generateProductContent({
            name: dto.name,
            description: dto.description,
            category: dto.category,
            subcategory: dto.subCategory,
            targetMarketplaces: targetMarketplaces || ['amazon', 'mercadolibre'],
            tone: tone || 'professional',
        });

        // Step 3: Map AI results to product fields
        const firstMarketplaceData = Object.values(aiContent.generatedListings || aiContent)[0] as any;

        if (firstMarketplaceData) {
            savedProduct.aiTitle = firstMarketplaceData.title || savedProduct.aiTitle;
            savedProduct.aiDescription = firstMarketplaceData.description || savedProduct.aiDescription;

            const bulletPoints = typeof firstMarketplaceData.bullet_points === 'string'
                ? [firstMarketplaceData.bullet_points]
                : firstMarketplaceData.bullet_points;

            savedProduct.aiKeywords = bulletPoints || savedProduct.aiKeywords;
            savedProduct.aiAttributes = typeof firstMarketplaceData.attributes === 'object'
                ? firstMarketplaceData.attributes
                : savedProduct.aiAttributes;
        }

        if (aiContent.categorizedAs) {
            savedProduct.marketplaceIds = aiContent.categorizedAs;
        }

        savedProduct.status = 'synced';

        // Step 4: Return the fully enriched product
        return this.productRepository.save(savedProduct);
    }

    async update(id: string, updateDto: Partial<CreateProductDto>, userId: string) {
        const product = await this.findOne(id, userId);

        const { images, ...productDetails } = updateDto;
        Object.assign(product, productDetails);

        if (images && images.length > 0) {
            product.images = images.map(url => this.productRepository.manager.create(ProductImage, { url }));
        }

        return this.productRepository.save(product);
    }

    async save(product: Product) {
        return this.productRepository.save(product);
    }

    async remove(id: string, userId: string) {
        const product = await this.findOne(id, userId);
        return this.productRepository.remove(product);
    }
}