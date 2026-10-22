import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { ProductImage } from './entities/product-image.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductWithAiDto } from './dto/create-product-with-ai.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { ExportQueryDto } from '../export/dto/export-query.dto';
import { AiService } from 'src/ai/ai.service';
import { SkuGeneratorService } from './sku-generator.service';
import { ListingLink } from '../sync/entities/listing-link.entity';

/**
 * Dónde debe ser único un SKU: dentro de una tienda. Un producto que todavía no tiene tienda (los de antes de las tiendas)
 * compite solo con los demás sin tienda de su dueño.
 */
export interface SkuScope {
    userId: string;
    storeId?: string | null;
}

@Injectable()
export class ProductsService {
    constructor(
        @InjectRepository(Product)
        private productRepository: Repository<Product>,
        private aiService: AiService,
        private skuGenerator: SkuGeneratorService,
    ) { }

    async create(createProductDto: CreateProductDto, userId: string, storeId?: string | null) {
        const { images = [], ...productDetails } = createProductDto;
        productDetails.sku = (productDetails.sku ?? '').trim();
        // Sin SKU escrito, se genera uno con el formato de la tienda.
        if (!productDetails.sku) productDetails.sku = (await this.skuGenerator.siguientes({ userId, storeId }))[0];

        // Cada SKU es único dentro de la tienda: ni repetido ni con otra combinación de mayúsculas o espacios
        await this.assertSkuLibre(productDetails.sku, { userId, storeId });

        const product = this.productRepository.create({
            ...productDetails,
            owner: { id: userId },
            ...(storeId ? { store: { id: storeId } } : {}),
            images: images.map(url => this.productRepository.manager.create(ProductImage, { url }))
        });
        return this.guardar(product, productDetails.sku);
    }

    /**
     * Guarda un producto. Si la base de datos rechaza el SKU por repetido (dos cargas a la vez pasaron el control previo),
     * se traduce a un mensaje claro: la unicidad real la garantiza un índice de la base.
     */
    private async guardar(product: Product, sku: string): Promise<Product> {
        try {
            return await this.productRepository.save(product);
        } catch (error: any) {
            if (error?.code === '23505' && /sku/i.test(String(error?.constraint ?? error?.detail ?? ''))) {
                throw new ConflictException(`El SKU "${sku}" ya está en uso en esta tienda. Cada producto necesita un SKU distinto.`);
            }
            throw error;
        }
    }

    /** Normaliza lo que llegue como ámbito: un id de usuario suelto (llamadas antiguas) o el ámbito completo. */
    private ambitoDe(scope: string | SkuScope): SkuScope {
        return typeof scope === 'string' ? { userId: scope, storeId: null } : scope;
    }

    /** Limita una consulta a los productos del mismo ámbito de unicidad que el SKU. */
    private enElAmbito(qb: any, scope: SkuScope) {
        if (scope.storeId) return qb.where('p."storeId" = :storeId', { storeId: scope.storeId });
        return qb.where('p."ownerId" = :userId', { userId: scope.userId }).andWhere('p."storeId" IS NULL');
    }

    /** El SKU identifica al producto en todos los canales: «abc-1» y «ABC-1 » son el mismo. */
    async assertSkuLibre(sku: string, scope: string | SkuScope, exceptId?: string): Promise<void> {
        const existing = await this.enElAmbito(this.productRepository.createQueryBuilder('p'), this.ambitoDe(scope))
            .andWhere('LOWER(TRIM(p.sku)) = LOWER(TRIM(:sku))', { sku })
            .andWhere(exceptId ? 'p.id <> :exceptId' : '1=1', { exceptId })
            .getOne();
        if (existing) {
            throw new ConflictException(
                `El SKU "${sku}" ya está en uso por el producto "${existing.name}" de esta tienda. Cada producto necesita un SKU distinto.`,
            );
        }
    }

    /** De una lista de SKUs, cuáles ya existen en la tienda (en minúsculas y sin espacios). */
    async skusExistentes(scope: string | SkuScope, skus: string[]): Promise<Set<string>> {
        const claves = [...new Set(skus.map((s) => s.trim().toLowerCase()).filter(Boolean))];
        if (!claves.length) return new Set();
        const filas: { sku: string }[] = await this.enElAmbito(this.productRepository.createQueryBuilder('p').select('LOWER(TRIM(p.sku))', 'sku'), this.ambitoDe(scope))
            .andWhere('LOWER(TRIM(p.sku)) IN (:...claves)', { claves })
            .getRawMany();
        return new Set(filas.map((f) => f.sku));
    }

    /** El producto de una tienda por su SKU (sin importar mayúsculas ni espacios); null si no existe. */
    async findBySku(scope: string | SkuScope, sku: string): Promise<Product | null> {
        return this.enElAmbito(this.productRepository.createQueryBuilder('p').leftJoinAndSelect('p.images', 'image'), this.ambitoDe(scope))
            .andWhere('LOWER(TRIM(p.sku)) = LOWER(TRIM(:sku))', { sku })
            .getOne();
    }

    async findAll(userId: string, query: QueryProductsDto) {
        const {
            page = 1, limit = 20,
            search, marketplace, category, subCategory,
            minPrice, maxPrice, inStock,
            sortBy = 'createdAt', order = 'desc',
        } = query;

        // Whitelist sortBy to prevent SQL injection via column name
        const allowedSortFields: Record<string, string> = {
            createdAt: 'product.createdAt',
            name:      'product.name',
            price:     'product.price',
            stock:     'product.stock',
            sku:       'product.sku',
        };
        const sortColumn = allowedSortFields[sortBy] ?? 'product.createdAt';

        const qb = this.productRepository
            .createQueryBuilder('product')
            .leftJoinAndSelect('product.images', 'image')
            .where('product.ownerId = :userId', { userId })
            .orderBy(sortColumn, order.toUpperCase() as 'ASC' | 'DESC')
            .skip((page - 1) * limit)
            .take(limit);

        // Full-text search across name, SKU and description
        if (search) {
            qb.andWhere(
                '(product.name ILIKE :q OR product.sku ILIKE :q OR product.description ILIKE :q)',
                { q: `%${search}%` },
            );
        }

        // Marketplace filter — targetMarketplaces is a JSON/text[] column
        if (marketplace) {
            qb.andWhere(
                `product.targetMarketplaces::text ILIKE :mp`,
                { mp: `%${marketplace.toLowerCase()}%` },
            );
        }

        if (category) {
            qb.andWhere('product.category ILIKE :category', { category: `%${category}%` });
        }

        if (subCategory) {
            qb.andWhere('product.subCategory ILIKE :subCategory', { subCategory: `%${subCategory}%` });
        }

        if (minPrice !== undefined) {
            qb.andWhere('product.price >= :minPrice', { minPrice });
        }

        if (maxPrice !== undefined) {
            qb.andWhere('product.price <= :maxPrice', { maxPrice });
        }

        if (inStock) {
            qb.andWhere('product.stock > 0');
        }

        const [data, total] = await qb.getManyAndCount();

        return {
            data,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                hasNextPage:     page < Math.ceil(total / limit),
                hasPreviousPage: page > 1,
            },
        };
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

        this.applyAiContent(product, aiContent);

        return this.productRepository.save(product);
    }

    async createWithAI(dto: CreateProductWithAiDto, userId: string, storeId?: string | null) {
        // Step 1: Check for duplicate SKU within the store BEFORE calling DeepSeek
        dto.sku = (dto.sku ?? '').trim();
        // Sin SKU escrito, se genera uno con el formato de la tienda.
        if (!dto.sku) dto.sku = (await this.skuGenerator.siguientes({ userId, storeId }))[0];
        await this.assertSkuLibre(dto.sku, { userId, storeId });

        const { tone, targetMarketplaces, images = [], ...productDetails } = dto;

        // El cliente puede dar solo fotos, SKU y precio: el nombre y la descripción los completa la IA.
        const descripcionDelCliente = (dto.description ?? '').trim();
        // El formulario manda el mismo texto como nombre y como descripción: si es igual a la descripción o es demasiado
        // largo para ser un nombre, no es un nombre y lo arma la IA.
        const nombreDado = (dto.name ?? '').trim();
        const nombreDelCliente = nombreDado && nombreDado !== descripcionDelCliente && nombreDado.length <= 150 ? nombreDado : '';
        const product = this.productRepository.create({
            ...productDetails,
            name: nombreDelCliente || dto.sku,
            description: descripcionDelCliente,
            owner: { id: userId },
            ...(storeId ? { store: { id: storeId } } : {}),
            images: images.map(url => this.productRepository.manager.create(ProductImage, { url })),
            status: 'pending',
        });
        const savedProduct = await this.guardar(product, dto.sku);

        // Step 2: Call DeepSeek (Phase A + Phase B)
        const aiContent = await this.aiService.generateProductContent({
            name: nombreDelCliente,
            description: descripcionDelCliente,
            category: dto.category,
            subcategory: dto.subCategory,
            targetMarketplaces: targetMarketplaces || ['amazon', 'mercadolibre'],
            tone: tone || 'professional',
            imageUrls: images,
            userId,
        });

        // Step 3: Map AI results to product fields
        this.applyAiContent(savedProduct, aiContent);

        savedProduct.status = 'synced';
        if (!nombreDelCliente) savedProduct.name = (savedProduct.aiTitle || aiContent.vision?.suggestedName || savedProduct.name || dto.sku).slice(0, 255);
        if (!descripcionDelCliente) savedProduct.description = savedProduct.aiDescription || aiContent.vision?.description || '';

        // Step 4: Return the fully enriched product, con lo que la IA vio y lo que aún falta
        const guardado = await this.productRepository.save(savedProduct);
        return Object.assign(guardado, {
            aiReport: {
                vision: aiContent.vision ?? null,
                missingAttributes: aiContent.missingAttributes ?? {},
                estimated: (guardado.aiAttributes as any)?.estimated ?? null,
            },
        });
    }

    async findAllForExport(userId: string, filters?: ExportQueryDto): Promise<Product[]> {
        const qb = this.productRepository
            .createQueryBuilder('product')
            .leftJoinAndSelect('product.images', 'image')
            .where('product.ownerId = :userId', { userId })
            .orderBy('product.createdAt', 'DESC');

        if (filters?.search) {
            qb.andWhere(
                '(product.name ILIKE :q OR product.sku ILIKE :q OR product.description ILIKE :q)',
                { q: `%${filters.search}%` },
            );
        }

        if (filters?.marketplace) {
            qb.andWhere(
                `product.targetMarketplaces::text ILIKE :mp`,
                { mp: `%${filters.marketplace.toLowerCase()}%` },
            );
        }

        if (filters?.category) {
            qb.andWhere('product.category ILIKE :category', { category: `%${filters.category}%` });
        }

        if (filters?.subCategory) {
            qb.andWhere('product.subCategory ILIKE :subCategory', { subCategory: `%${filters.subCategory}%` });
        }

        if (filters?.minPrice !== undefined) {
            qb.andWhere('product.price >= :minPrice', { minPrice: filters.minPrice });
        }

        if (filters?.maxPrice !== undefined) {
            qb.andWhere('product.price <= :maxPrice', { maxPrice: filters.maxPrice });
        }

        if (filters?.inStock) {
            qb.andWhere('product.stock > 0');
        }

        return qb.getMany();
    }

    async update(id: string, updateDto: Partial<CreateProductDto>, userId: string) {
        const product = await this.productRepository.findOne({ where: { id, owner: { id: userId } }, relations: { store: true } });
        if (!product) throw new NotFoundException('Producto no encontrado');

        const { images, ...productDetails } = updateDto;
        // El SKU se puede corregir mientras el producto no se haya publicado en ningún canal; después identifica la ficha
        // en cada canal y ya no se cambia.
        if (productDetails.sku !== undefined) {
            const nuevo = productDetails.sku.trim();
            if (nuevo && nuevo.toLowerCase() !== product.sku.trim().toLowerCase()) {
                if (await this.tienePublicaciones(product.id)) {
                    throw new BadRequestException('El SKU no se puede cambiar una vez publicado. Si te equivocaste, elimina el producto y créalo de nuevo.');
                }
                await this.assertSkuLibre(nuevo, { userId, storeId: product.store?.id ?? null }, product.id);
                productDetails.sku = nuevo;
            } else {
                delete (productDetails as any).sku;
            }
        }
        Object.assign(product, productDetails);

        if (images && images.length > 0) {
            product.images = images.map(url => this.productRepository.manager.create(ProductImage, { url }));
        }

        return this.productRepository.save(product);
    }

    /** ¿Ya se intentó publicar este producto en algún canal? Desde ahí su SKU no se cambia. */
    private async tienePublicaciones(productId: string): Promise<boolean> {
        return (await this.productRepository.manager.count(ListingLink, { where: { product: { id: productId } } })) > 0;
    }

    async save(product: Product) {
        return this.productRepository.save(product);
    }

    async remove(id: string, userId: string) {
        const product = await this.findOne(id, userId);
        return this.productRepository.remove(product);
    }

    /**
     * Vuelca lo que generó la IA sobre el producto.
     *
     * Cada canal responde con una forma distinta: Mercado Libre y Amazon
     * traen `title` y sus atributos agrupados, mientras que Falabella usa
     * `name` y deja marca, modelo y condición sueltos en la raíz. Antes solo
     * se leía el primer canal buscando `title` y `attributes`, así que todo
     * lo de Falabella se perdía en silencio y luego la publicación fallaba
     * pidiendo datos que la IA sí había generado.
     */
    applyAiContent(product: Product, aiContent: any): void {
        const listings = aiContent?.generatedListings ?? aiContent ?? {};
        const primero = Object.values(listings)[0] as any;

        if (primero) {
            // Falabella nombra el título como `name`.
            product.aiTitle = primero.title || primero.name || product.aiTitle;
            product.aiDescription = primero.description || product.aiDescription;

            const bulletPoints = typeof primero.bullet_points === 'string'
                ? [primero.bullet_points]
                : primero.bullet_points;
            product.aiKeywords = bulletPoints || product.aiKeywords;

            if (typeof primero.attributes === 'object' && primero.attributes) {
                product.aiAttributes = primero.attributes;
            }
        }

        // Los campos propios de Falabella se suman a los atributos, que es
        // donde los busca la publicación. No pisan lo que ya hubiera.
        const falabella = (listings as any).falabella;
        if (falabella) {
            const propios: Record<string, any> = {
                brand: falabella.brand,
                model: falabella.model,
                productionCountry: falabella.productionCountry,
                conditionType: falabella.conditionType,
            };
            for (const clave of Object.keys(propios)) {
                if (!propios[clave]) delete propios[clave];
            }
            product.aiAttributes = { ...((product.aiAttributes as any) || {}), ...propios };

            // Si Falabella fue el único canal pedido, su descripción es la buena.
            if (!product.aiDescription && falabella.description) {
                product.aiDescription = falabella.description;
            }
        }

        // Los atributos de cada canal se guardan aparte: el primero ya no tapa a los demás.
        // Mercado Libre los manda con su id; los de Falabella se leen por nombre, desde la raíz.
        const completos = (obj: any): Record<string, any> =>
            Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== ''));
        const meli = completos((listings as any).mercadolibre?.attributes);
        if (Object.keys(meli).length) {
            product.aiAttributes = { ...((product.aiAttributes as any) || {}), mercadolibre_attributes: meli };
        }
        const delFalabella = completos((listings as any).falabella?.attributes);
        if (Object.keys(delFalabella).length) {
            product.aiAttributes = { ...delFalabella, ...((product.aiAttributes as any) || {}) };
        }

        // Medidas del paquete: las que dio el cliente mandan; si no, las estimadas quedan marcadas para revisión.
        const paquete = aiContent?.packageEstimate;
        if (paquete) {
            if (product.packageWidth == null) product.packageWidth = paquete.width;
            if (product.packageLength == null) product.packageLength = paquete.length;
            if (product.packageHeight == null) product.packageHeight = paquete.height;
            if (product.packageWeight == null) product.packageWeight = paquete.weight;
        }
        if (paquete || Object.keys(aiContent?.estimatedAttributes ?? {}).length) {
            product.aiAttributes = {
                ...((product.aiAttributes as any) || {}),
                estimated: { measures: !!paquete && !paquete.fromClient, attributes: aiContent?.estimatedAttributes ?? {} },
            };
        }

        // Ficha HTML estándar de la agencia (Falabella, Shopify, WooCommerce).
        if (aiContent?.htmlDescription) {
            product.aiAttributes = { ...((product.aiAttributes as any) || {}), descriptionHtml: aiContent.htmlDescription };
        }

        // Lo que se vio en las fotos: la marca y el color quedan listos para publicar.
        const vision = aiContent?.vision;
        if (vision) {
            const actuales = (product.aiAttributes as any) || {};
            product.aiAttributes = {
                ...actuales,
                brand: actuales.brand || vision.brand || undefined,
                color: actuales.color || vision.color || undefined,
                vision,
            };
        }

        if (aiContent?.categorizedAs) {
            product.marketplaceIds = {
                ...((product.marketplaceIds as any) || {}),
                ...aiContent.categorizedAs,
            };
        }

        // Resultado de verificar la categoría de Falabella: queda anotado para que la Ficha avise si hay que revisarla.
        const chequeo = aiContent?.categoryChecks?.falabella;
        if (chequeo) {
            const atributos: Record<string, any> = { ...((product.aiAttributes as any) || {}) };
            if (chequeo.id) atributos._categoriaVerificada = chequeo.id;
            if (chequeo.id && chequeo.confianza === 'alta') delete atributos._categoriaDudosa;
            else atributos._categoriaDudosa = { id: chequeo.id ?? null, motivo: chequeo.motivo ?? 'revisa que la categoría sea la correcta' };
            product.aiAttributes = atributos as any;
        }
    }

}