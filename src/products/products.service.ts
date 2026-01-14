import {Injectable, NotFoundException} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { AIService } from 'src/ai/ai.service';

@Injectable()
export class ProductsService {
    constructor(
        @InjectRepository(Product)
        private productRepository: Repository<Product>,
        private aiService: AIService,
    ){}

    async create(createProductDto: CreateProductDto, userId: string){
        const product = this.productRepository.create({
            ...createProductDto,
            owner: { id: userId}
        });
        return this.productRepository.save(product);
    }

    async findAll(userId: string){
        return this.productRepository.find({
            where: { owner: { id: userId } },
            order: { createdAt: 'DESC'},
        });
    }

    async findOne(id: string, userId: string){
        const product = await this.productRepository.findOne({
            where: { id, owner: { id: userId}},
        });
        if(!product){
            throw new NotFoundException('Producto no encontrado');
        }
        return product;
    }

    async generateAIContent(productId: string, userId: string, options?: { tone?: string; marketplaces?: string[]}){
        const product = await this.findOne(productId, userId);

        const aiContent = await this.aiService.generateProductContent({
            name: product.name,
            description: product.description,
            category: product.category,
            subcategory: product.subCategory,
            targetMarketplaces: options?.marketplaces || product.targetMarketplaces,
            tone: options?.tone || 'professional',
        });

        product.aiTitle = aiContent.title;
        product.aiDescription = aiContent.description;
        product.aiKeywords = aiContent.keywords;
        product.aiAttributes = aiContent.attributes;

        return this.productRepository.save(product);
    };

    async update(id: string, updateDto: Partial<CreateProductDto>, userId: string){
        const product = await this.findOne(id, userId);
        Object.assign(product, updateDto);
        return this.productRepository.save(product);
    }

    async remove(id: string, userId: string){
        const product = await this.findOne(id, userId);
        return this.productRepository.remove(product);
    }
}