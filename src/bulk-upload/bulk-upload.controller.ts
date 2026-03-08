import {
    Controller, Post, Get,
    UseInterceptors, UploadedFile,
    BadRequestException,
    HttpCode, HttpStatus, UseGuards, Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as xlsx from 'xlsx';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';

@ApiTags('bulk-upload')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('bulk-upload')
export class BulkUploadController {
    constructor(
        @InjectQueue('generate-listings-queue') private readonly listingsQueue: Queue,
        @InjectQueue('category-seed-queue') private readonly categorySeedQueue: Queue,
        @InjectQueue('product-edit-queue') private readonly productEditQueue: Queue,
        @InjectQueue('category-edit-queue') private readonly categoryEditQueue: Queue,
    ) { }

    // ─────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────
    private getVal(row: any, keys: string[]): string | undefined {
        const found = Object.keys(row).find(k => keys.includes(k.toLowerCase().trim()));
        return found ? String(row[found]).trim() : undefined;
    }

    private parseExcel(buffer: Buffer): any[] {
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        return xlsx.utils.sheet_to_json(worksheet);
    }

    // ─────────────────────────────────────────────────────────────
    // POST /bulk-upload/products — Bulk CREATE products via AI
    // ─────────────────────────────────────────────────────────────
    @Post('products')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Carga un archivo Excel para crear productos en lote mediante IA' , description: `Columnas: sku (obligatorio) | productName | description | targetMarketplaces (coma-separado).`})
    @ApiConsumes('multipart/form-data')
    @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
    @UseInterceptors(FileInterceptor('file'))
    async uploadExcel(@UploadedFile() file: Express.Multer.File, @Req() req) {
        if (!file) throw new BadRequestException('El archivo Excel es obligatorio.');

        try {
            const rows = this.parseExcel(file.buffer);
            if (rows.length === 0) throw new BadRequestException('El Excel esta vacio.');

            console.log('[BulkUpload] Columnas detectadas:', Object.keys(rows[0] as object));

            const mapped = rows.map((row: any) => ({
                sku: this.getVal(row, ['sku']),
                productName: this.getVal(row, ['productname', 'nombre', 'name', 'producto']),
                description: this.getVal(row, ['description', 'descripcion', 'descripcion', 'detalle']),
                targetMarketplaces: (this.getVal(row, ['targetmarketplaces', 'marketplaces']) || 'amazon,mercadolibre')
                    .split(',').map(s => s.trim().toLowerCase()),
                userId: req.user.id,
            })).filter(r => {
                const ok = r.sku && r.productName && r.description;
                if (!ok) console.log(`[BulkUpload] Fila descartada -> SKU: ${r.sku}, Nombre: ${r.productName}`);
                return ok;
            });

            for (const item of mapped) await this.listingsQueue.add('process-product', item);

            return { message: 'Tareas encoladas para procesamiento en segundo plano.', totalQueued: mapped.length };
        } catch (error) {
            if (error instanceof BadRequestException) throw error;
            throw new BadRequestException('Error al leer el archivo Excel.');
        }
    }

    // ─────────────────────────────────────────────────────────────
    // POST /bulk-upload/products/edit — Bulk EDIT own products
    // ─────────────────────────────────────────────────────────────
    @Post('products/edit')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Edicion masiva de tus productos via Excel',
        description: `Columnas: sku (obligatorio) | name | description | price | stock | category | subCategory | targetMarketplaces (coma-separado).
Solo se actualizan los campos presentes en el Excel. Solo puedes editar tus propios productos.`,
    })
    @ApiConsumes('multipart/form-data')
    @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
    @UseInterceptors(FileInterceptor('file'))
    async uploadProductEdits(@UploadedFile() file: Express.Multer.File, @Req() req) {
        if (!file) throw new BadRequestException('El archivo Excel es obligatorio.');

        try {
            const rows = this.parseExcel(file.buffer);
            if (rows.length === 0) throw new BadRequestException('El Excel esta vacio.');

            let totalQueued = 0;
            let totalSkipped = 0;

            for (const row of rows as any[]) {
                const sku = this.getVal(row, ['sku']);
                if (!sku) { totalSkipped++; continue; }

                const rawMarketplaces = this.getVal(row, ['targetmarketplaces', 'marketplaces']);

                const jobData: Record<string, any> = { sku, userId: req.user.id };
                const name = this.getVal(row, ['name', 'nombre']);
                const description = this.getVal(row, ['description', 'descripcion', 'descripcion', 'detalle']);
                const price = this.getVal(row, ['price', 'precio']);
                const stock = this.getVal(row, ['stock']);
                const category = this.getVal(row, ['category', 'categoria', 'categoría']);
                const subCategory = this.getVal(row, ['subcategory', 'subcategoria', 'subcategoría']);

                if (name) jobData.name = name;
                if (description) jobData.description = description;
                if (price) jobData.price = parseFloat(price);
                if (stock) jobData.stock = parseInt(stock);
                if (category) jobData.category = category;
                if (subCategory) jobData.subCategory = subCategory;
                if (rawMarketplaces) jobData.targetMarketplaces = rawMarketplaces.split(',').map(s => s.trim().toLowerCase());

                await this.productEditQueue.add('edit-product', jobData, {
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 2000 },
                });
                totalQueued++;
            }

            return {
                message: `${totalQueued} productos encolados para edicion. ${totalSkipped} filas descartadas (sin SKU).`,
                totalQueued,
                totalSkipped,
            };
        } catch (error) {
            if (error instanceof BadRequestException) throw error;
            throw new BadRequestException('Error al leer el archivo Excel.');
        }
    }

    // ─────────────────────────────────────────────────────────────
    // GET /bulk-upload/products/edit/status
    // ─────────────────────────────────────────────────────────────
    @Get('products/edit/status')
    @ApiOperation({ summary: 'Estado de la cola de edicion masiva de productos' })
    async getProductEditStatus() {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
            this.productEditQueue.getWaitingCount(),
            this.productEditQueue.getActiveCount(),
            this.productEditQueue.getCompletedCount(),
            this.productEditQueue.getFailedCount(),
            this.productEditQueue.getDelayedCount(),
        ]);
        return { waiting, active, completed, failed, delayed };
    }

    // ─────────────────────────────────────────────────────────────
    // POST /bulk-upload/categories — Bulk CREATE categories [ADMIN]
    // ─────────────────────────────────────────────────────────────
    @Post('categories')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: '[ADMIN] Carga masiva de categorias desde un archivo Excel',
        description: `Columnas obligatorias: marketplace | categoryId | name | labelText
Columna opcional: requiredAttributes (JSON string).
Ejemplo: [{"name":"ShoeSize","description":"Talla US","example":"10.5","isRequired":true}]`,
    })
    @ApiConsumes('multipart/form-data')
    @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
    @UseInterceptors(FileInterceptor('file'))
    async uploadCategoriesExcel(@UploadedFile() file: Express.Multer.File) {
        if (!file) throw new BadRequestException('El archivo Excel es obligatorio.');

        try {
            const rows = this.parseExcel(file.buffer);
            if (rows.length === 0) throw new BadRequestException('El Excel esta vacio.');

            let totalQueued = 0;
            let totalSkipped = 0;

            for (const row of rows as any[]) {
                const marketplace = this.getVal(row, ['marketplace']);
                const categoryId = this.getVal(row, ['categoryid', 'category_id', 'id']);
                const name = this.getVal(row, ['name', 'nombre']);
                const labelText = this.getVal(row, ['labeltext', 'label_text', 'label', 'keywords']);

                if (!marketplace || !categoryId || !name || !labelText) {
                    console.log(`[BulkCategories] Fila descartada -> categoryId: ${categoryId}`);
                    totalSkipped++;
                    continue;
                }

                let requiredAttributes: any[] = [];
                const rawAttrs = this.getVal(row, ['requiredattributes', 'required_attributes', 'attributes', 'atributos']);
                if (rawAttrs) {
                    try { requiredAttributes = JSON.parse(rawAttrs); }
                    catch { console.warn(`[BulkCategories] No se pudo parsear requiredAttributes para ${categoryId}`); }
                }

                await this.categorySeedQueue.add('seed-category', {
                    marketplace: marketplace.toLowerCase(),
                    categoryId,
                    name,
                    labelText,
                    requiredAttributes,
                }, { attempts: 3, backoff: { type: 'exponential', delay: 3000 } });

                totalQueued++;
            }

            return {
                message: `${totalQueued} categorias encoladas. ${totalSkipped} filas descartadas por datos incompletos.`,
                totalQueued,
                totalSkipped,
            };
        } catch (error) {
            if (error instanceof BadRequestException) throw error;
            throw new BadRequestException('Error al leer el archivo Excel.');
        }
    }

    // ─────────────────────────────────────────────────────────────
    // GET /bulk-upload/categories/status [ADMIN]
    // ─────────────────────────────────────────────────────────────
    @Get('categories/status')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @ApiOperation({ summary: '[ADMIN] Estado de la cola de carga masiva de categorias' })
    async getCategoryQueueStatus() {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
            this.categorySeedQueue.getWaitingCount(),
            this.categorySeedQueue.getActiveCount(),
            this.categorySeedQueue.getCompletedCount(),
            this.categorySeedQueue.getFailedCount(),
            this.categorySeedQueue.getDelayedCount(),
        ]);
        return { waiting, active, completed, failed, delayed };
    }

    // ─────────────────────────────────────────────────────────────
    // POST /bulk-upload/categories/edit — Bulk EDIT categories [ADMIN]
    // ─────────────────────────────────────────────────────────────
    @Post('categories/edit')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: '[ADMIN] Edicion masiva de categorias via Excel',
        description: `Columnas identificadoras (obligatorias): categoryId | marketplace
Columnas editables (opcionales): name | labelText | requiredAttributes (JSON string).
Si cambia labelText, el embedding se regenera automaticamente.`,
    })
    @ApiConsumes('multipart/form-data')
    @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
    @UseInterceptors(FileInterceptor('file'))
    async uploadCategoryEdits(@UploadedFile() file: Express.Multer.File) {
        if (!file) throw new BadRequestException('El archivo Excel es obligatorio.');

        try {
            const rows = this.parseExcel(file.buffer);
            if (rows.length === 0) throw new BadRequestException('El Excel esta vacio.');

            let totalQueued = 0;
            let totalSkipped = 0;

            for (const row of rows as any[]) {
                const categoryId = this.getVal(row, ['categoryid', 'category_id', 'id']);
                const marketplace = this.getVal(row, ['marketplace']);

                if (!categoryId || !marketplace) {
                    console.log(`[BulkCategoryEdit] Fila descartada -> falta categoryId o marketplace`);
                    totalSkipped++;
                    continue;
                }

                const jobData: Record<string, any> = {
                    categoryId,
                    marketplace: marketplace.toLowerCase(),
                };

                const name = this.getVal(row, ['name', 'nombre']);
                const labelText = this.getVal(row, ['labeltext', 'label_text', 'label', 'keywords']);
                const rawAttrs = this.getVal(row, ['requiredattributes', 'required_attributes', 'attributes', 'atributos']);

                if (name) jobData.name = name;
                if (labelText) jobData.labelText = labelText;
                if (rawAttrs) {
                    try { jobData.requiredAttributes = JSON.parse(rawAttrs); }
                    catch { console.warn(`[BulkCategoryEdit] No se pudo parsear requiredAttributes para ${categoryId}`); }
                }

                await this.categoryEditQueue.add('edit-category', jobData, {
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 3000 },
                });
                totalQueued++;
            }

            return {
                message: `${totalQueued} categorias encoladas para edicion. ${totalSkipped} filas descartadas.`,
                totalQueued,
                totalSkipped,
            };
        } catch (error) {
            if (error instanceof BadRequestException) throw error;
            throw new BadRequestException('Error al leer el archivo Excel.');
        }
    }

    // ─────────────────────────────────────────────────────────────
    // GET /bulk-upload/categories/edit/status [ADMIN]
    // ─────────────────────────────────────────────────────────────
    @Get('categories/edit/status')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @ApiOperation({ summary: '[ADMIN] Estado de la cola de edicion masiva de categorias' })
    async getCategoryEditStatus() {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
            this.categoryEditQueue.getWaitingCount(),
            this.categoryEditQueue.getActiveCount(),
            this.categoryEditQueue.getCompletedCount(),
            this.categoryEditQueue.getFailedCount(),
            this.categoryEditQueue.getDelayedCount(),
        ]);
        return { waiting, active, completed, failed, delayed };
    }
}
