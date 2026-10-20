import {
    Controller, Post, Get,
    UseInterceptors, UploadedFile, UploadedFiles, Res,
    BadRequestException,
    HttpCode, HttpStatus, UseGuards, Req,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor, AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Response } from 'express';
import { leerPrimeraHoja, escribirHoja } from '../common/excel/excel';
import { COLUMNAS, MAX_FOTOS, claveDeRuta, esJpg, esUrl, fotosDeCarpeta, leerFecha, leerPrecio, leerStock, partirLista } from './bulk-products';
import * as AdmZip from 'adm-zip';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSection, SectionAccessGuard } from '../common/guards/section-access.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { UploadService } from '../upload/upload.service';
import { StoreAccessGuard } from '../stores/store-access.guard';
import { SyncService } from '../sync/sync.service';
import { ProductsService } from '../products/products.service';
import { StoresService } from '../stores/stores.service';
import { nombreDeArchivo, plantillaDeProductos } from './product-template';

/** Canales donde la carga masiva puede publicar sola. */
const CANALES_PUBLICABLES = ['mercadolibre', 'falabella'];

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
        private readonly syncService: SyncService,
        private readonly productsService: ProductsService,
        private readonly stores: StoresService,
    ) { }

    // ─────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────
    private getVal(row: any, keys: string[]): string | undefined {
        const found = Object.keys(row).find(k => keys.includes(k.toLowerCase().trim()));
        return found ? String(row[found]).trim() : undefined;
    }

    private parseExcel(buffer: Buffer): Promise<any[]> {
        return leerPrimeraHoja(buffer);
    }

    /**
     * Sube a Cloudinary las fotos de un producto y devuelve sus direcciones (la primera es la principal).
     * Cada foto es una dirección web o una ruta dentro del ZIP; si la fila no las lista, se buscan en el ZIP por SKU.
     * Solo JPG.
     */
    private async resolverFotos(
        sku: string,
        valor: string | undefined,
        zipEntries: Map<string, Buffer>,
        otrosSkus: Set<string>,
    ): Promise<string[]> {
        const indicadas = partirLista(valor);
        const lista = indicadas.length ? indicadas : fotosDeCarpeta(sku, [...zipEntries.keys()], otrosSkus);
        if (!lista.length) {
            throw new Error('no tiene fotos: escribe sus rutas en la columna fotos o ponlas en el ZIP con el SKU en el nombre (MK-001.jpg, MK-001-2.jpg) o en una carpeta con el SKU');
        }
        if (lista.length > MAX_FOTOS) lista.length = MAX_FOTOS;

        const urls: string[] = [];
        for (const ruta of lista) {
            if (!esJpg(ruta)) throw new Error(`la foto "${ruta}" no es JPG: solo se aceptan .jpg o .jpeg`);
            if (esUrl(ruta)) {
                urls.push(await this.uploadService.validateExternalUrl(ruta.trim()));
                continue;
            }
            const entrada = zipEntries.get(claveDeRuta(ruta));
            if (!entrada) {
                throw new Error(`no se encontró la foto "${ruta}" en el ZIP (¿subiste el ZIP junto al Excel?)`);
            }
            urls.push((await this.uploadService.uploadBuffer(entrada, ruta, 'products')).secureUrl);
        }
        return urls;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /bulk-upload/products/template — plantilla de Excel
    // ─────────────────────────────────────────────────────────────
    @Get('products/template')
    @UseGuards(StoreAccessGuard)
    @ApiOperation({ summary: 'Descarga la plantilla de Excel de la tienda activa: la lista de canales solo muestra los conectados' })
    async downloadTemplate(@Req() req, @Res() res: Response) {
        const storeId: string = req.store.storeId;
        const tienda = (await this.stores.listMine(req.user.id)).stores.find((t: any) => t.id === storeId)?.name ?? '';
        const canales = [...new Set((await this.syncService.getConnections(storeId))
            .filter((c: any) => c.status === 'active' && CANALES_PUBLICABLES.includes(c.marketplace))
            .map((c: any) => c.marketplace as string))];
        const buffer = await plantillaDeProductos(tienda, canales);
        // Se responde directo: el interceptor global envolvería el archivo en JSON y Excel no podría abrirlo.
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${nombreDeArchivo(tienda)}"`,
        });
        return res.send(buffer);
    }

    // ─────────────────────────────────────────────────────────────
    // POST /bulk-upload/products — Bulk CREATE products via AI
    // ─────────────────────────────────────────────────────────────
    @Post('products')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Carga un archivo Excel para crear productos en lote mediante IA',
        description: `Archivos: excel (obligatorio) + zip (opcional, con las fotos JPG).
Columnas: sku | precio | stock | fotos | nombre | descripcion | canales | precio_descuento | descuento_desde | descuento_hasta (las últimas siete son opcionales).
fotos: rutas dentro del ZIP o direcciones web, separadas por coma. Si va vacía, se buscan en el ZIP las fotos cuyo nombre empieza por el SKU o que están en una carpeta con el SKU.`,
    })
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                excel: { type: 'string', format: 'binary', description: 'Archivo Excel de productos' },
                zip:   { type: 'string', format: 'binary', description: 'ZIP con las fotos JPG (opcional)' },
            },
            required: ['excel'],
        },
    })
    @UseGuards(StoreAccessGuard)
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
                    if (!entry.isDirectory && !entry.entryName.includes('__MACOSX')) {
                        zipEntries.set(claveDeRuta(entry.entryName), entry.getData());
                    }
                }
                console.log(`[BulkUpload] ZIP cargado con ${zipEntries.size} archivos.`);
            } catch {
                throw new BadRequestException('No se pudo leer el archivo ZIP.');
            }
        }

        try {
            const rows = await this.parseExcel(excelFile.buffer);
            if (rows.length === 0) throw new BadRequestException('El Excel esta vacio.');
            console.log('[BulkUpload] Columnas detectadas:', Object.keys(rows[0] as object));

            const rechazos: string[] = [];
            const rechazar = (i: number, motivo: string) => { rechazos.push(`Fila ${i + 2}: ${motivo}`); };

            // Canales de la tienda donde se puede publicar sola. Solo el dueño publica;
            // el resto de los roles crea los productos y los deja listos.
            const storeId: string | undefined = req.store?.storeId;
            const conectados: string[] = storeId && req.store?.role === 'owner'
                ? [...new Set((await this.syncService.getConnections(storeId))
                    .filter((c: any) => c.status === 'active' && CANALES_PUBLICABLES.includes(c.marketplace))
                    .map((c: any) => c.marketplace as string))]
                : [];

            // Canales marcados en pantalla: valen para las filas que no traen su propia columna `canales`.
            const marcados = partirLista(String(req.body?.canales ?? '')).map(t => t.toLowerCase()).filter(t => CANALES_PUBLICABLES.includes(t));

            // 1) Datos de cada fila. Cada SKU es único: se descartan los repetidos dentro del Excel y los que ya existen.
            const skusDelExcel = rows.map((row: any) => this.getVal(row, COLUMNAS.sku) ?? '');
            const existentes = await this.productsService.skusExistentes(req.user.id, skusDelExcel);
            const otrosSkus = new Set(skusDelExcel.map(x => claveDeRuta(x)).filter(Boolean));
            const vistos = new Map<string, number>();
            type Fila = { i: number; sku: string; precio: number; precioDescuento: number | null; desde: string | null; hasta: string | null; stock: number; nombre: string; descripcion: string; fotos?: string; canales: string[] };
            const validas: Fila[] = [];
            rows.forEach((row: any, i: number) => {
                const sku = (this.getVal(row, COLUMNAS.sku) ?? '').trim();
                if (!sku) return rechazar(i, 'falta el SKU');
                const clave = sku.toLowerCase();
                if (existentes.has(clave)) return rechazar(i, `el SKU ${sku} ya existe en tus productos`);
                if (vistos.has(clave)) return rechazar(i, `el SKU ${sku} está repetido en el Excel (también en la fila ${vistos.get(clave)! + 2})`);
                vistos.set(clave, i);

                const precio = leerPrecio(this.getVal(row, COLUMNAS.precio));
                if (precio === null) return rechazar(i, `${sku}: falta el precio o no es válido`);
                const stock = leerStock(this.getVal(row, COLUMNAS.stock));
                if (stock === null) return rechazar(i, `${sku}: el stock debe ser un número entero`);

                // Descuento opcional: menor que el precio y con fechas en orden.
                const textoDescuento = this.getVal(row, COLUMNAS.precioDescuento);
                const precioDescuento = textoDescuento ? leerPrecio(textoDescuento) : null;
                if (textoDescuento && precioDescuento === null) return rechazar(i, `${sku}: el precio con descuento no es válido`);
                if (precioDescuento !== null && precioDescuento >= precio) return rechazar(i, `${sku}: el precio con descuento (${precioDescuento}) debe ser menor que el precio (${precio})`);
                const desde = leerFecha(this.getVal(row, COLUMNAS.descuentoDesde));
                const hasta = leerFecha(this.getVal(row, COLUMNAS.descuentoHasta));
                if (desde === undefined || hasta === undefined) return rechazar(i, `${sku}: las fechas del descuento no se entienden (usa AAAA-MM-DD, por ejemplo 2026-11-30)`);
                if (desde && hasta && hasta < desde) return rechazar(i, `${sku}: la fecha de fin del descuento es anterior a la de inicio`);

                // Sin columna de canales se usan los marcados en pantalla o, si no hay, todos los conectados.
                const indicados = partirLista(this.getVal(row, COLUMNAS.canales)).map(t => t.toLowerCase());
                validas.push({
                    i, sku, precio, precioDescuento, desde: precioDescuento !== null ? desde : null, hasta: precioDescuento !== null ? hasta : null, stock,
                    nombre: (this.getVal(row, COLUMNAS.nombre) ?? '').trim(),
                    descripcion: (this.getVal(row, COLUMNAS.descripcion) ?? '').trim(),
                    fotos: this.getVal(row, COLUMNAS.fotos),
                    canales: indicados.length ? indicados : (marcados.length ? marcados : (conectados.length ? conectados : ['mercadolibre'])),
                });
            });

            // 2) Fotos de las filas que pasaron: se suben antes de encolar (puede tardar).
            const fotos = await Promise.allSettled(validas.map(f => this.resolverFotos(f.sku, f.fotos, zipEntries, otrosSkus)));
            const listas: { fila: Fila; urls: string[] }[] = [];
            fotos.forEach((r, k) => {
                const fila = validas[k];
                if (r.status === 'rejected') {
                    console.warn(`[BulkUpload] Fila ${fila.i + 2} (SKU: ${fila.sku}) rechazada -> ${r.reason?.message}`);
                    rechazar(fila.i, `${fila.sku}: ${r.reason?.message ?? 'foto inválida'}`);
                } else {
                    listas.push({ fila, urls: r.value });
                }
            });

            // 3) A la cola. El total del lote se calcula antes: todos los trabajos conocen el mismo valor.
            const batchId = randomUUID();
            const batchTotal = listas.length;
            for (const { fila, urls } of listas) {
                await this.listingsQueue.add('process-product', {
                    sku: fila.sku,
                    productName: fila.nombre,
                    description: fila.descripcion,
                    price: fila.precio,
                    salePrice: fila.precioDescuento,
                    saleStartDate: fila.desde,
                    saleEndDate: fila.hasta,
                    stock: fila.stock,
                    targetMarketplaces: fila.canales,
                    // Se publica solo donde la tienda tiene cuenta conectada.
                    publishTo: fila.canales.filter(t => conectados.includes(t)),
                    storeId,
                    userId:     req.user.id,
                    userEmail:  req.user.email,
                    imageUrls: urls,
                    batchId,
                    batchTotal,
                });
            }

            return {
                message: `${batchTotal} productos encolados. ${rows.length - batchTotal} filas rechazadas.`,
                totalQueued: batchTotal,
                totalSkipped: rows.length - batchTotal,
                zipImagesLoaded: zipEntries.size,
                ...(rechazos.length && { rejectedDetails: rechazos }),
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
            const rows = await this.parseExcel(file.buffer);
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
            const rows = await this.parseExcel(file.buffer);
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
            const rows = await this.parseExcel(file.buffer);
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
