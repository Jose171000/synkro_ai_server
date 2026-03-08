import { Injectable, OnApplicationBootstrap, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketplaceCategory } from './entities/marketplace-category.entity';
import { REDIS_CLIENT } from '../redis/redis.module';
import Redis from 'ioredis';
import OpenAI from 'openai';

const SEED_CATEGORIES: Omit<MarketplaceCategory, 'id' | 'embedding' | 'createdAt' | 'updatedAt'>[] = [
    // ==================== AMAZON ====================
    {
        marketplace: 'amazon',
        categoryId: 'elec_headphones',
        name: 'Headphones & Earbuds',
        labelText: 'headphones earbuds auriculares audífonos bluetooth wireless earphones music audio',
        requiredAttributes: [
            { name: 'Bluetooth_Version', description: 'Versión del protocolo Bluetooth del dispositivo', example: '5.0', isRequired: true },
            { name: 'Color', description: 'Color principal del producto en inglés', example: 'Black', isRequired: true },
            { name: 'Battery_Life', description: 'Duración de la batería en horas de uso continuo', example: '30 hours', isRequired: false },
        ],
    },
    {
        marketplace: 'amazon',
        categoryId: 'elec_smartphones',
        name: 'Smartphones',
        labelText: 'smartphone celular teléfono móvil android iphone apple samsung galaxy phone',
        requiredAttributes: [
            { name: 'Operating_System', description: 'Sistema operativo del teléfono', example: 'Android 14', isRequired: true },
            { name: 'Storage_Capacity', description: 'Capacidad de almacenamiento interno', example: '256 GB', isRequired: true },
            { name: 'Screen_Size', description: 'Tamaño de la pantalla en pulgadas', example: '6.7 inches', isRequired: false },
        ],
    },
    {
        marketplace: 'amazon',
        categoryId: 'shoes_athletic',
        name: "Men's Athletic Shoes",
        labelText: 'zapatillas tenis running deportivo athletic shoes sneakers nike adidas puma deportes correr',
        requiredAttributes: [
            { name: 'ShoeSize', description: 'Talla del calzado en sistema US (número)', example: '10.5', isRequired: true },
            { name: 'OuterMaterialType', description: 'Material exterior de la suela o parte superior', example: 'Rubber', isRequired: true },
            { name: 'DepartmentName', description: 'Género de destino del calzado', example: 'Men', isRequired: false },
        ],
    },
    {
        marketplace: 'amazon',
        categoryId: 'clothing_shirts',
        name: 'T-Shirts',
        labelText: 'camiseta remera polo shirt playera algodón ropa casual manga corta hombre mujer',
        requiredAttributes: [
            { name: 'Size', description: 'Talla de la prenda (S, M, L, XL, XXL)', example: 'L', isRequired: true },
            { name: 'Color', description: 'Color principal de la prenda en inglés', example: 'White', isRequired: true },
            { name: 'Material', description: 'Composición del tejido principal', example: '100% Cotton', isRequired: false },
        ],
    },
    // ==================== MERCADOLIBRE ====================
    {
        marketplace: 'mercadolibre',
        categoryId: 'MLA1001',
        name: 'Auriculares',
        labelText: 'auriculares audífonos headphones bluetooth inalámbrico música audio sony bose',
        requiredAttributes: [
            { name: 'Formato_del_auricular', description: 'Tipo de diseño del auricular', example: 'Over-ear', isRequired: true },
            { name: 'Con_Bluetooth', description: 'Si el auricular tiene conectividad Bluetooth', example: 'Sí', isRequired: true },
            { name: 'Es_inalambrico', description: 'Si el auricular funciona sin cable', example: 'Sí', isRequired: false },
        ],
    },
    {
        marketplace: 'mercadolibre',
        categoryId: 'MLA1002',
        name: 'Celulares y Smartphones',
        labelText: 'celular smartphone teléfono android iphone samsung xiaomi motorola galaxy',
        requiredAttributes: [
            { name: 'Memoria_Interna', description: 'Capacidad de almacenamiento interno del celular', example: '256 GB', isRequired: true },
            { name: 'Memoria_RAM', description: 'Memoria RAM disponible en el dispositivo', example: '8 GB', isRequired: true },
            { name: 'Camara_Principal', description: 'Resolución de la cámara trasera principal', example: '50 MP', isRequired: false },
        ],
    },
    {
        marketplace: 'mercadolibre',
        categoryId: 'MLA2001',
        name: 'Zapatillas',
        labelText: 'zapatillas tenis deportivas running calzado deportivo nike adidas puma converse',
        requiredAttributes: [
            { name: 'Material_del_interior', description: 'Material del forro interno de la zapatilla', example: 'Textil', isRequired: true },
            { name: 'Genero', description: 'Género al que está destinado el calzado', example: 'Hombre', isRequired: true },
            { name: 'Estilo', description: 'Estilo funcional del calzado', example: 'Running', isRequired: false },
        ],
    },
    {
        marketplace: 'mercadolibre',
        categoryId: 'MLA2002',
        name: 'Remeras',
        labelText: 'remera camiseta polo shirt ropa casual algodón hombre mujer manga corta estampado',
        requiredAttributes: [
            { name: 'Tipo_de_tela', description: 'Material principal de confección de la remera', example: 'Jersey', isRequired: true },
            { name: 'Diseno_de_la_tela', description: 'Diseño visual o estampado de la tela', example: 'Liso', isRequired: false },
            { name: 'Tipo_de_manga', description: 'Longitud y estilo de las mangas', example: 'Manga corta', isRequired: false },
        ],
    },
];

@Injectable()
export class CategorySeederService implements OnApplicationBootstrap {
    private openai: OpenAI;

    constructor(
        @InjectRepository(MarketplaceCategory)
        private categoryRepository: Repository<MarketplaceCategory>,
        @Inject(REDIS_CLIENT)
        private readonly redis: Redis,
    ) {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    /**
     * Runs automatically when the NestJS application boots.
     * Seeds the database with categories and their embeddings if they don't already exist.
     * ✅ OPTIMIZATION 1: Uses Promise.all for parallel embedding generation.
     */
    async onApplicationBootstrap() {
        const apiKey = process.env.OPENAI_API_KEY;
        const deepseekKey = process.env.DEEPSEEK_API_KEY;

        if (!apiKey || apiKey === deepseekKey) {
            console.warn('[CategorySeeder] OPENAI_API_KEY not configured. Skipping seed.');
            return;
        }

        const existingCount = await this.categoryRepository.count();
        if (existingCount > 0) {
            console.log(`[CategorySeeder] ${existingCount} categories already in DB. Skipping seed.`);
            return;
        }

        console.log(`[CategorySeeder] Seeding ${SEED_CATEGORIES.length} categories in parallel...`);
        const startTime = Date.now();

        const results = await Promise.allSettled(
            SEED_CATEGORIES.map(async (seed) => {
                const vector = await this.generateEmbedding(seed.labelText);
                const entity = this.categoryRepository.create({ ...seed, embedding: vector });
                await this.categoryRepository.save(entity);
                console.log(`[CategorySeeder] ✓ Seeded: [${seed.marketplace}] ${seed.name}`);
            }),
        );

        const failed = results.filter(r => r.status === 'rejected').length;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (failed > 0) {
            console.warn(`[CategorySeeder] Seed complete with ${failed} error(s) in ${elapsed}s`);
        } else {
            console.log(`[CategorySeeder] ✅ Seed complete — ${SEED_CATEGORIES.length} categories in ${elapsed}s`);
        }
    }

    /**
     * Generates an embedding for arbitrary text.
     * ✅ OPTIMIZATION 2: Redis cache with 24h TTL — avoids redundant OpenAI calls.
     */
    async generateEmbedding(text: string): Promise<number[]> {
        const normalizedText = text.trim().toLowerCase();
        const cacheKey = `embedding:${this.hashText(normalizedText)}`;

        // 1. Check Redis cache first
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                return JSON.parse(cached) as number[];
            }
        } catch {
            console.warn('[CategorySeeder] Redis unavailable, calling OpenAI directly.');
        }

        // 2. Cache miss — call OpenAI
        const response = await this.openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: normalizedText,
        });
        const embedding = response.data[0].embedding;

        // 3. Store result in Redis with 24h TTL
        try {
            await this.redis.setex(cacheKey, 86400, JSON.stringify(embedding));
        } catch {
            console.warn('[CategorySeeder] Could not write embedding to Redis cache.');
        }

        return embedding;
    }

    /**
     * Simple djb2-style hash for deterministic cache key generation.
     */
    private hashText(text: string): string {
        let hash = 5381;
        for (let i = 0; i < text.length; i++) {
            hash = (hash * 33) ^ text.charCodeAt(i);
        }
        return (hash >>> 0).toString(16);
    }
}
