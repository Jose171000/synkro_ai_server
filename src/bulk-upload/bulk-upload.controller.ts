import {
    Controller, Post, Get,
    UseInterceptors, UploadedFile, UploadedFiles,
    BadRequestException,
    HttpCode, HttpStatus, UseGuards, Req,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor, AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as xlsx from 'xlsx';
import * as AdmZip from 'adm-zip';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSection, SectionAccessGuard } from '../common/guards/section-access.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { UploadService } from '../upload/upload.service';

@ApiTags('bulk-upload')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SectionAccessGuard)
@RequireSection('ai-products')
@Controller('bulk-upload')
export class BulkUploadController {
    constructor(
        @InjectQueue('generate-listings-queue') private readonly listingsQueue: Queue,
        @InjectQueue('category-seed-queue')     private readonly categorySeedQueue: Queue,
        @InjectQueue('product-edit-queue')      private readonly productEditQueue: Queue,
        @InjectQueue('category-edit-queue')     private readonly categoryEditQueue: Queue,
        private readonly uploadService: UploadService,
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

    /**
     * Resolves an image field value to a final URL:
     * - If it's an external URL (http/https): validate JPEG + dimensions, return as-is
     * - Otherwise: treat as a ZIP path, extract buffer, upload to Cloudinary
     */
    private async resolveImageUrl(
        value: string | undefined,
        zipEntries: Map<string, Buffer>,
    ): Promise<string | undefined> {
        if (!value) throw new Error('El campo image es obligatorio.');

        if (value.startsWith('http://') || value.startsWith('https://')) {
            // Will throw BadRequestException if not JPEG or exceeds 2000x2000px
            return await this.uploadService.validateExternalUrl(value);
        }

        // Treat as ZIP path — throw if not found or upload fails
        const normalizedPath = value.replace(/\\/g, '/').toLowerCase();
        const entry = zipEntries.get(normalizedPath);
        if (!entry) {
            throw new Error(`Ruta de imagen no encontrada en el ZIP: "${value}"`);
        }

        const result = await this.uploadService.uploadBuffer(entry, value, 'products');
        return result.secureUrl;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /bulk-upload/products — Bulk CREATE products via AI
    // ─────────────────────────────────────────────────────────────
    @Post('products')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Carga un archivo Excel para crear productos en lote mediante IA',
        description: `Archivos: excel (obligatorio) + zip (opcional, con imágenes JPG/JPEG).
Columnas Excel: sku | productName | description | targetMarketplaces | image
El campo image puede ser una URL externa (JPG, máx 2000x2000) o una ruta dentro del ZIP (ej: fotos/SKU-001.jpg).`,
    })
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                excel: { type: 'string', format: 'binary', description: 'Archivo Excel de productos' },
                zip:   { type: 'string', format: 'binary', description: 'ZIP con imágenes (opcional)' },
            },
            required: ['excel'],
        },
    })
    @UseInterceptors(AnyFilesInterceptor())
    async uploadExcel(@UploadedFiles() files: Express.Multer.File[], @Req() req) {
        const excelFile = files?.find(f => f.fieldname === 'excel');
        const zipFile   = files?.find(f => f.fieldname === 'zip');

        if (!excelFile) throw new BadRequestException('El archivo Excel es obligatorio (campo: excel).');

        // Build a map of ZIP entries: normalizedPath → buffer
        const zipEntries = new Map<string, Buffer>();
        if (zipFile) {
            try {
                const zip = new AdmZip(zipFile.buffer);
                for (const entry of zip.getEntries()) {
                    if (!entry.isDirectory) {
                        const key = entry.entryName.replace(/\\/g, '/').toLowerCase();
                        zipEntries.set(key, entry.getData());
                    }
                }
                console.log(`[BulkUpload] ZIP cargado con ${zipEntries.size} archivos.`);
            } catch {
                throw new BadRequestException('No se pudo leer el archivo ZIP.');
            }
        }

        try {
            const rows = this.parseExcel(excelFile.buffer);
            if (rows.length === 0) throw new BadRequestException('El Excel esta vacio.');
            console.log('[BulkUpload] Columnas detectadas:', Object.keys(rows[0] as object));

            // Resolve all images in parallel before enqueueing (may upload to Cloudinary)
            const resolvedImages = await Promise.allSettled(
                rows.map((row: any) => this.resolveImageUrl(
                    this.getVal(row, ['image', 'imagen', 'img', 'photo', 'foto']),
                    zipEntries,
                ))
            );

            let totalQueued = 0;
            let totalSkipped = 0;
            const rejectedImages: string[] = [];
            const batchId = randomUUID(); // unique ID for this bulk-upload batch

            // Pre-count valid rows so each job knows the correct batchTotal
            const validRows = rows.filter((_row: any, i: number) => {
                const row: any = rows[i];
                const sku         = this.getVal(row, ['sku']);
                const productName = this.getVal(row, ['productname', 'nombre', 'name', 'producto']);
                const description = this.getVal(row, ['description', 'descripcion', 'descripcion', 'detalle']);
                const settled     = resolvedImages[i];
                return sku && productName && description && settled.status === 'fulfilled';
            });
            const batchTotal = validRows.length;

            for (let i = 0; i < rows.length; i++) {
                const row: any = rows[i];
                const sku         = this.getVal(row, ['sku']);
                const productName = this.getVal(row, ['productname', 'nombre', 'name', 'producto']);
                const description = this.getVal(row, ['description', 'descripcion', 'descripcion', 'detalle']);

                if (!sku || !productName || !description) {
                    console.log(`[BulkUpload] Fila ${i+1} descartada -> SKU: ${sku}, Nombre: ${productName}`);
                    totalSkipped++;
                    continue;
                }

                const settled = resolvedImages[i];
                if (settled.status === 'rejected') {
                    const reason = settled.reason?.message ?? 'imagen inválida';
                    console.warn(`[BulkUpload] Fila ${i+1} (SKU: ${sku}) rechazada -> ${reason}`);
                    rejectedImages.push(`SKU ${sku}: ${reason}`);
                    totalSkipped++;
                    continue;
                }

                const imageUrl = (settled as PromiseFulfilledResult<string | undefined>).value;

                await this.listingsQueue.add('process-product', {
                    sku,
                    productName,
                    description,
                    targetMarketplaces: (this.getVal(row, ['targetmarketplaces', 'marketplaces']) || 'amazon,mercadolibre')
                        .split(',').map((s: string) => s.trim().toLowerCase()),
                    userId:     req.user.id,
                    userEmail:  req.user.email,
                    imageUrl,
                    batchId,
                    batchTotal, // Pre-computed before the loop: always the same correct value for all jobs
                });
                totalQueued++;
            }

            return {
                message: `${totalQueued} productos encolados. ${totalSkipped} filas rechazadas.`,
                totalQueued,
                totalSkipped,
                zipImagesLoaded: zipEntries.size,
                ...(rejectedImages.length && { rejectedDetails: rejectedImages }),
            };
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
