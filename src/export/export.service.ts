import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ProductsService, SkuScope } from '../products/products.service';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { datosQueFaltan, estadoDeCanal, nombreDeCanal } from '../products/completitud';
import { ExportQueryDto } from './dto/export-query.dto';
import { Product } from '../products/entities/product.entity';
import { escribirHoja } from '../common/excel/excel';

export type ExportFormat = 'json' | 'csv' | 'xlsx';

@Injectable()
export class ExportService {
    constructor(
        private readonly productsService: ProductsService,
        @InjectRepository(ListingLink) private readonly listingLinkRepository: Repository<ListingLink>,
    ) {}

    // ─── Data fetching ───────────────────────────────────────────────

    async getProductsForExport(scope: SkuScope, filters?: ExportQueryDto): Promise<Product[]> {
        return this.productsService.findAllForExport(scope, filters);
    }

    /** Publicaciones reales de cada producto, para mostrar en qué canal y en qué estado está. */
    async listingsDe(products: Product[]): Promise<Map<string, ListingLink[]>> {
        const porProducto = new Map<string, ListingLink[]>();
        if (!products.length) return porProducto;
        const enlaces = await this.listingLinkRepository.find({ where: { product: { id: In(products.map((p) => p.id)) } }, relations: { product: true, connection: true } });
        for (const e of enlaces) porProducto.set(e.product.id, [...(porProducto.get(e.product.id) ?? []), e]);
        return porProducto;
    }

    // ─── Data mapping ────────────────────────────────────────────────

    mapProductsForExport(products: Product[], listings: Map<string, ListingLink[]> = new Map()): Record<string, any>[] {
        return products.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            description: p.description,
            category: p.category ?? '',
            subCategory: p.subCategory ?? '',
            categoryFalabellaId: (p.marketplaceIds as any)?.falabella_category_id ?? '',
            categoryMercadoLibreId: (p.marketplaceIds as any)?.mercadolibre_category_id ?? (p.aiAttributes as any)?.mercadolibre_category_id ?? '',
            group: (p as any).group?.name ?? '',
            groupCode: (p as any).group?.parentSku ?? '',
            variant: p.variantValues ? Object.entries(p.variantValues).map(([k, v]) => `${k}: ${v}`).join(', ') : '',
            channels: (listings.get(p.id) ?? [])
                .map((l) => `${nombreDeCanal(l.marketplace)}${l.connection?.label ? ` (${l.connection.label})` : ''}: ${estadoDeCanal(l)}`)
                .join(' | '),
            missing: datosQueFaltan(p).join(', '),
            price: p.price ?? '',
            stock: p.stock ?? 0,
            status: p.status,
            targetMarketplaces: Array.isArray(p.targetMarketplaces)
                ? p.targetMarketplaces.join(', ')
                : p.targetMarketplaces ?? '',
            images: Array.isArray(p.images)
                ? p.images.map((img) => img.url).join(', ')
                : '',
            createdAt: p.createdAt?.toISOString() ?? '',
            updatedAt: p.updatedAt?.toISOString() ?? '',
        }));
    }

    mapAiContentForExport(products: Product[]): Record<string, any>[] {
        return products.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            aiTitle: p.aiTitle ?? '',
            aiDescription: p.aiDescription ?? '',
            aiKeywords: Array.isArray(p.aiKeywords)
                ? p.aiKeywords.join(', ')
                : p.aiKeywords ?? '',
            aiAttributes: p.aiAttributes
                ? JSON.stringify(p.aiAttributes)
                : '',
            marketplaceIds: p.marketplaceIds
                ? JSON.stringify(p.marketplaceIds)
                : '',
            targetMarketplaces: Array.isArray(p.targetMarketplaces)
                ? p.targetMarketplaces.join(', ')
                : p.targetMarketplaces ?? '',
            status: p.status,
        }));
    }

    // ─── Serializers ─────────────────────────────────────────────────

    toJSON(data: Record<string, any>[]): Buffer {
        const jsonString = JSON.stringify(data, null, 2);
        return Buffer.from(jsonString, 'utf-8');
    }

    toCSV(data: Record<string, any>[]): Buffer {
        if (data.length === 0) {
            return Buffer.from('', 'utf-8');
        }

        const headers = Object.keys(data[0]);
        const headerLine = headers.map((h) => this.escapeCsvField(h)).join(',');

        const rows = data.map((row) =>
            headers
                .map((h) => this.escapeCsvField(String(row[h] ?? '')))
                .join(','),
        );

        // BOM for Excel UTF-8 compatibility
        const bom = '\uFEFF';
        const csvContent = bom + [headerLine, ...rows].join('\r\n');
        return Buffer.from(csvContent, 'utf-8');
    }

    toXLSX(data: Record<string, any>[], sheetName: string): Promise<Buffer> {
        return escribirHoja(data, sheetName);
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    /**
     * Generate a timestamped filename for the export.
     */
    generateFilename(prefix: string, format: ExportFormat): string {
        const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        return `synkro_${prefix}_${date}.${format}`;
    }

    /**
     * Returns the appropriate Content-Type header for each format.
     */
    getContentType(format: ExportFormat): string {
        const contentTypes: Record<ExportFormat, string> = {
            json: 'application/json; charset=utf-8',
            csv: 'text/csv; charset=utf-8',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
        return contentTypes[format];
    }

    /**
     * Escapes a CSV field value (wraps in quotes, escapes internal quotes).
     */
    private escapeCsvField(value: string): string {
        if (
            value.includes(',') ||
            value.includes('"') ||
            value.includes('\n') ||
            value.includes('\r')
        ) {
            return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
    }
}
