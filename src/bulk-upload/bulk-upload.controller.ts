import {
    Controller, Post, Get,
    UseInterceptors, UploadedFile, UploadedFiles, Res,
    BadRequestException, NotFoundException, Param, ParseUUIDPipe,
    HttpCode, HttpStatus, UseGuards, Req,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor, AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Response } from 'express';
import { leerPrimeraHoja, escribirHoja } from '../common/excel/excel';
import { COLUMNAS, MAX_FOTOS, claveDeRuta, esJpg, esUrl, esUrlSinExtension, fotosDeCarpeta, leerFecha, leerPrecio, leerStock, partirLista } from './bulk-products';
import * as AdmZip from 'adm-zip';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSection, SectionAccessGuard } from '../common/guards/section-access.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { UploadService } from '../upload/upload.service';
import { RequirePermission, StoreAccessGuard } from '../stores/store-access.guard';
import { SyncService } from '../sync/sync.service';
import { ProductsService } from '../products/products.service';
import { SkuGeneratorService } from '../products/sku-generator.service';
import { StoresService } from '../stores/stores.service';
import { BatchNotificationService } from './batch-notification.service';
import { allSettledConLimite, concurrenciaDeFotos } from './concurrencia-fotos';
import { BulkBatchService } from './bulk-batch.service';
import { leerCuentasElegidas } from '../sync/cuentas-elegidas';
import { EdicionMasivaService } from './edicion-masiva.service';
import { nombreDeArchivo, plantillaDeProductos } from './product-template';
import { armarGrupos, codigosConVariantes, GrupoDeCarga } from './grupos-de-carga';
import { asignarSkus } from '../products/variantes';
import { hoyEnLima } from '../sync/descuento-general';

/** Canales donde la carga masiva puede publicar sola. */
const CANALES_PUBLICABLES = ['mercadolibre', 'falabella', 'woocommerce'];

/** La fila no indica fotos y el ZIP no tiene ninguna con su SKU (una variante puede usar entonces las de su grupo). */
class SinFotos extends Error { }

const OPCIONES_DE_TRABAJO = {
    // Un fallo pasajero de la IA (límite de llamadas, red) se reintenta antes de dar el producto por fallido.
    attempts: 3,
    backoff: { type: 'exponential', delay: 15_000 },
};

/**
 * Renglones del registro del lote para un trabajo. Un producto suelto es un renglón; un grupo de variantes, uno por variante:
 * el primero guarda el trabajo entero (para «Reintentar») y los demás solo apuntan al grupo.
 */
function renglonesDelTrabajo(trabajo: any): { sku: string; payload: Record<string, any> }[] {
    if (trabajo?.tipo !== 'grupo') return [{ sku: trabajo.sku, payload: trabajo }];
    return trabajo.variants.map((v: any, k: number) => ({ sku: v.sku, payload: k === 0 ? trabajo : { grupoDe: trabajo.parentSku, cuentas: trabajo.cuentas } }));
}

/** Cuántos productos lleva un trabajo (un grupo cuenta cada variante). */
const productosDelTrabajo = (trabajo: any): number => (trabajo?.tipo === 'grupo' ? trabajo.variants.length : 1);

/** El nombre del archivo subido: multer lo entrega como latin1 y las tildes llegan rotas. */
function nombreDelExcel(original: string | undefined): string {
    const crudo = String(original ?? '');
    const utf8 = Buffer.from(crudo, 'latin1').toString('utf8');
    return utf8.includes('\uFFFD') ? crudo : utf8;
}

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
        private readonly skuGenerator: SkuGeneratorService,
        private readonly batchNotification: BatchNotificationService,
        private readonly bulkBatch: BulkBatchService,
        private readonly edicionMasiva: EdicionMasivaService,
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
            throw new SinFotos('no tiene fotos: escribe sus rutas en la columna fotos o ponlas en el ZIP con el SKU en el nombre (MK-001.jpg, MK-001-2.jpg) o en una carpeta con el SKU');
        }
        if (lista.length > MAX_FOTOS) lista.length = MAX_FOTOS;

        const urls: string[] = [];
        for (const ruta of lista) {
            // Un enlace sin extensión no dice su formato: se abre y, si es JPG, se guarda una copia propia terminada en .jpg.
            if (esUrlSinExtension(ruta)) {
                urls.push(await this.uploadService.copiarJpgExterno(ruta.trim()));
                continue;
            }
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

    /**
     * SKU de las variantes de un grupo: los escritos se respetan (ya se comprobó que están libres) y los vacíos se arman con el
     * código del grupo y los valores (GOLDEN-PREM-QUEEN), sin chocar con los del Excel (`ocupados`) ni con los de la tienda.
     */
    private async skusDeVariantes(grupo: GrupoDeCarga<{ i: number; grupo: string; sku: string; ejes: { nombre: string; valor: string }[] }>, ocupados: Set<string>, scope: { userId: string; storeId?: string }): Promise<string[]> {
        const entradas = grupo.filas.map((f, k) => ({ valores: grupo.valores[k], sku: f.sku || null }));
        const escritos = new Set(grupo.filas.map((f) => f.sku.toLowerCase()).filter(Boolean));
        let tomados = new Set([...ocupados].filter((s) => !escritos.has(s)));
        for (let intento = 0; intento < 5; intento++) {
            const skus = asignarSkus(grupo.codigo, entradas, grupo.ejes, tomados);
            const generados = skus.filter((_, k) => !entradas[k].sku);
            const enLaTienda = generados.length ? await this.productsService.skusExistentes(scope, generados) : new Set<string>();
            if (!generados.some((s) => enLaTienda.has(s.toLowerCase()))) return skus;
            tomados = new Set([...tomados, ...enLaTienda]);
        }
        throw new Error('no se pudieron generar SKU libres para sus variantes: escríbelos en la columna sku');
    }

    // ─────────────────────────────────────────────────────────────
    // GET /bulk-upload/products/template — plantilla de Excel
    // ─────────────────────────────────────────────────────────────
    @Get('products/template')
    @RequirePermission('productos.editar')
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
    @RequirePermission('productos.editar')
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
            const filasRechazadas = new Set<number>();
            const rechazar = (i: number, motivo: string) => { rechazos.push(`Fila ${i + 2}: ${motivo}`); filasRechazadas.add(i); };

            // Canales de la tienda donde se puede publicar sola. Solo quien tiene el permiso de publicar (dueño y editor, de
            // fábrica); los demás crean los productos y los dejan listos.
            const storeId: string | undefined = req.store?.storeId;
            const scope = { userId: req.user.id as string, storeId };
            const conectados: string[] = storeId && req.store?.permissions?.includes('canales.publicar')
                ? [...new Set((await this.syncService.getConnections(storeId))
                    .filter((c: any) => c.status === 'active' && CANALES_PUBLICABLES.includes(c.marketplace))
                    .map((c: any) => c.marketplace as string))]
                : [];

            // Canales marcados en pantalla: valen para las filas que no traen su propia columna `canales`.
            const marcados = partirLista(String(req.body?.canales ?? '')).map(t => t.toLowerCase()).filter(t => CANALES_PUBLICABLES.includes(t));

            // Ejes de variación de cada fila (eje_1/valor_1…). Un «sku_padre» con ejes es un producto con variantes; sin ejes, como antes.
            const leerEjes = (row: any) => COLUMNAS.ejes.map((c) => ({ nombre: (this.getVal(row, c.eje) ?? '').trim(), valor: (this.getVal(row, c.valor) ?? '').trim() }));
            const filasCrudas = rows.map((row: any, i: number) => ({ i, grupo: (this.getVal(row, COLUMNAS.grupo) ?? '').trim(), ejes: leerEjes(row) }));
            const conVariantes = codigosConVariantes(filasCrudas);
            const grupoDe = (i: number): string => { const g = filasCrudas[i].grupo.toLowerCase(); return g && conVariantes.has(g) ? g : ''; };

            // 1) Datos de cada fila. Cada SKU es único: se descartan los repetidos dentro del Excel y los que ya existen.
            const skusDelExcel = rows.map((row: any) => this.getVal(row, COLUMNAS.sku) ?? '');
            const existentes = await this.productsService.skusExistentes(scope, skusDelExcel);
            // Los que otra carga aún no terminó de crear tampoco están libres.
            const enCola = await this.bulkBatch.skusEnCola(req.user.id, storeId);
            const otrosSkus = new Set(skusDelExcel.map(x => claveDeRuta(x)).filter(Boolean));
            const vistos = new Map<string, number>();
            type Fila = { i: number; grupo: string; sku: string; precio: number; precioDescuento: number | null; desde: string | null; hasta: string | null; stock: number; nombre: string; descripcion: string; fotos?: string; canales: string[]; ejes: { nombre: string; valor: string }[] };
            const validas: Fila[] = [];
            rows.forEach((row: any, i: number) => {
                const sku = (this.getVal(row, COLUMNAS.sku) ?? '').trim();
                // Una fila sin SKU no se rechaza: recibe uno generado (más abajo).
                const ref = sku || '(sin SKU)';
                if (sku) {
                    const clave = sku.toLowerCase();
                    if (existentes.has(clave)) return rechazar(i, `el SKU ${sku} ya existe en tus productos`);
                    if (enCola.has(clave)) return rechazar(i, `el SKU ${sku} está en una carga que todavía se está procesando`);
                    if (vistos.has(clave)) return rechazar(i, `el SKU ${sku} está repetido en el Excel (también en la fila ${vistos.get(clave)! + 2})`);
                    vistos.set(clave, i);
                }

                const precio = leerPrecio(this.getVal(row, COLUMNAS.precio));
                if (precio === null) return rechazar(i, `${ref}: falta el precio o no es válido`);
                const stock = leerStock(this.getVal(row, COLUMNAS.stock));
                if (stock === null) return rechazar(i, `${ref}: el stock debe ser un número entero`);

                // Descuento opcional: menor que el precio y con fechas en orden.
                const textoDescuento = this.getVal(row, COLUMNAS.precioDescuento);
                const precioDescuento = textoDescuento ? leerPrecio(textoDescuento) : null;
                if (textoDescuento && precioDescuento === null) return rechazar(i, `${ref}: el precio con descuento no es válido`);
                if (precioDescuento !== null && precioDescuento >= precio) return rechazar(i, `${ref}: el precio con descuento (${precioDescuento}) debe ser menor que el precio (${precio})`);
                const desde = leerFecha(this.getVal(row, COLUMNAS.descuentoDesde));
                const hasta = leerFecha(this.getVal(row, COLUMNAS.descuentoHasta));
                if (desde === undefined || hasta === undefined) return rechazar(i, `${ref}: las fechas del descuento no se entienden (usa AAAA-MM-DD, por ejemplo 2026-11-30)`);
                if (desde && hasta && hasta < desde) return rechazar(i, `${ref}: la fecha de fin del descuento es anterior a la de inicio`);
                // Como en «Descuento» de la app: un descuento necesita fecha de fin (Falabella rechaza la ficha entera sin fechas).
                // Sin fecha de inicio, empieza hoy.
                if (precioDescuento !== null && !hasta) return rechazar(i, `${ref}: el precio con descuento necesita su fecha de fin en descuento_hasta (AAAA-MM-DD, por ejemplo 2026-12-31)`);
                if (precioDescuento !== null && hasta && hasta < hoyEnLima()) return rechazar(i, `${ref}: la fecha de fin del descuento (${hasta}) ya pasó`);

                // Sin columna de canales se usan los marcados en pantalla o, si no hay, todos los conectados.
                const indicados = partirLista(this.getVal(row, COLUMNAS.canales)).map(t => t.toLowerCase());
                validas.push({
                    i, grupo: filasCrudas[i].grupo, sku, precio, precioDescuento, desde: precioDescuento !== null ? (desde ?? hoyEnLima()) : null, hasta: precioDescuento !== null ? hasta : null, stock,
                    nombre: (this.getVal(row, COLUMNAS.nombre) ?? '').trim(),
                    descripcion: (this.getVal(row, COLUMNAS.descripcion) ?? '').trim(),
                    fotos: this.getVal(row, COLUMNAS.fotos),
                    canales: indicados.length ? indicados : (marcados.length ? marcados : (conectados.length ? conectados : ['mercadolibre'])),
                    ejes: filasCrudas[i].ejes,
                });
            });

            // 1b) Productos con variantes: las filas con el mismo «sku_padre» y sus ejes forman UN producto. Un grupo se crea
            // completo o no se crea: si una de sus filas tiene un error, el grupo entero queda fuera con el motivo.
            const sueltas = validas.filter((f) => !grupoDe(f.i));
            const armado = armarGrupos(validas.filter((f) => grupoDe(f.i)));
            const descartar = (filas: number[], motivo: string) => { for (const i of filas) if (!filasRechazadas.has(i)) rechazar(i, motivo); };
            for (const e of armado.errores) descartar(e.filas, e.motivo);
            const filasDelGrupo = (codigo: string) => filasCrudas.filter((f) => grupoDe(f.i) === codigo.toLowerCase()).map((f) => f.i);
            const skusEscritos = new Set(skusDelExcel.map((s) => s.trim().toLowerCase()).filter(Boolean));
            const codigosOcupados = await this.productsService.skusExistentes(scope, armado.grupos.map((g) => g.codigo));
            let grupos: GrupoDeCarga<Fila>[] = armado.grupos.filter((g) => {
                const filas = filasDelGrupo(g.codigo);
                const caidas = filas.filter((i) => filasRechazadas.has(i));
                const codigo = g.codigo.toLowerCase();
                let motivo = '';
                if (caidas.length) motivo = `el producto con variantes ${g.codigo} no se creó porque ${caidas.length === 1 ? 'la fila' : 'las filas'} ${caidas.map((i) => i + 2).join(', ')} ${caidas.length === 1 ? 'tiene' : 'tienen'} un error (se crea completo o no se crea)`;
                else if (!storeId) motivo = `el producto con variantes ${g.codigo} necesita una tienda activa`;
                else if (skusEscritos.has(codigo)) motivo = `el sku_padre ${g.codigo} es también el SKU de una fila del Excel: el código del grupo debe ser distinto de los SKU de las variantes`;
                else if (enCola.has(codigo)) motivo = `el sku_padre ${g.codigo} está en una carga que todavía se está procesando`;
                else if (codigosOcupados.has(codigo)) motivo = `el sku_padre ${g.codigo} ya existe en tu tienda (como SKU de un producto o código de otro grupo): usa otro código`;
                if (motivo) descartar(filas, motivo);
                return !motivo;
            });

            // Las filas sueltas sin SKU reciben uno con el formato de la tienda (consecutivos, sin chocar con los escritos ni con los grupos).
            const sinSku = sueltas.filter((f) => !f.sku);
            const skusGenerados: { fila: number; sku: string }[] = [];
            if (sinSku.length) {
                const nuevos = await this.skuGenerator.siguientes(scope, sinSku.length, new Set([...vistos.keys(), ...grupos.map((g) => g.codigo.toLowerCase()), ...enCola]));
                sinSku.forEach((f, k) => { f.sku = nuevos[k]; skusGenerados.push({ fila: f.i + 2, sku: nuevos[k] }); });
            }

            // Las variantes sin SKU reciben uno con el código del grupo y sus valores (GOLDEN-PREM-QUEEN), como al crearlas en la app.
            const ocupados = new Set<string>([...vistos.keys(), ...sueltas.map((f) => f.sku.toLowerCase()), ...grupos.map((g) => g.codigo.toLowerCase()), ...enCola]);
            for (const g of [...grupos]) {
                try {
                    const skus = await this.skusDeVariantes(g, ocupados, scope);
                    g.filas.forEach((f, k) => {
                        if (!f.sku) skusGenerados.push({ fila: f.i + 2, sku: skus[k] });
                        f.sku = skus[k];
                        ocupados.add(skus[k].toLowerCase());
                    });
                } catch (error: any) {
                    descartar(g.filas.map((f) => f.i), `el producto con variantes ${g.codigo} no se creó: ${error?.message ?? 'no se pudieron asignar los SKU'}`);
                    grupos = grupos.filter((x) => x !== g);
                }
            }

            // 2) Fotos de las filas que pasaron: se suben antes de encolar (puede tardar).
            // Con BULK_PHOTO_CONCURRENCY se limita cuántos productos suben fotos a la vez; sin la variable, todos a la vez como siempre.
            const conFotos = [...sueltas, ...grupos.flatMap((g) => g.filas)];
            const fotos = await allSettledConLimite(conFotos, concurrenciaDeFotos(process.env.BULK_PHOTO_CONCURRENCY), f => this.resolverFotos(f.sku, f.fotos, zipEntries, otrosSkus));
            const resultadoDeFotos = new Map(conFotos.map((f, k) => [f.i, fotos[k]]));
            const listas: { fila: Fila; urls: string[] }[] = [];
            for (const fila of sueltas) {
                const r = resultadoDeFotos.get(fila.i)!;
                if (r.status === 'rejected') {
                    console.warn(`[BulkUpload] Fila ${fila.i + 2} (SKU: ${fila.sku}) rechazada -> ${r.reason?.message}`);
                    rechazar(fila.i, `${fila.sku}: ${r.reason?.message ?? 'foto inválida'}`);
                } else {
                    listas.push({ fila, urls: r.value });
                }
            }
            // Una variante sin fotos propias usa las de la primera fila del grupo que tenga (útil cuando las medidas se ven iguales).
            const gruposListos: { grupo: GrupoDeCarga<Fila>; urls: string[][] }[] = [];
            for (const g of grupos) {
                const resultados = g.filas.map((f) => resultadoDeFotos.get(f.i)!);
                const malas = g.filas.map((f, k) => ({ f, r: resultados[k] })).filter(({ r }) => r.status === 'rejected' && !(r.reason instanceof SinFotos));
                const respaldo = resultados.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<string[]> | undefined;
                let motivo = '';
                if (malas.length) motivo = `el producto con variantes ${g.codigo} no se creó: ${malas.map(({ f, r }) => `fila ${f.i + 2} (${f.sku}) ${(r as PromiseRejectedResult).reason?.message ?? 'foto inválida'}`).join('; ')}`;
                else if (!respaldo) motivo = `el producto con variantes ${g.codigo} no tiene fotos: escríbelas en la columna fotos (basta en la primera fila) o ponlas en el ZIP con el SKU de la variante en el nombre`;
                if (motivo) { descartar(g.filas.map((f) => f.i), motivo); continue; }
                gruposListos.push({ grupo: g, urls: resultados.map((r) => (r.status === 'fulfilled' ? r.value : respaldo!.value)) });
            }

            // 3) A la cola. El total del lote (en productos: cada variante cuenta) se calcula antes: todos los trabajos conocen el mismo valor.
            const batchId = randomUUID();
            const batchTotal = listas.length + gruposListos.reduce((n, x) => n + x.grupo.filas.length, 0);
            if (batchTotal) await this.batchNotification.iniciar(batchId, batchTotal, req.user.id);
            // Cuentas elegidas por canal (si la tienda tiene varias): { mercadolibre: [idCuenta] }. Sin elección, todas las activas.
            const cuentas = leerCuentasElegidas(req.body?.cuentas);
            const comun = { cuentas, storeId, userId: req.user.id, userEmail: req.user.email, batchId, batchTotal };
            const trabajos: any[] = listas.map(({ fila, urls }) => ({
                sku: fila.sku,
                // Las filas con el mismo «sku_padre» (sin ejes) son variantes de un producto: se categorizan UNA vez y comparten la categoría.
                grupoClave: fila.grupo || null,
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
                imageUrls: urls,
                ...comun,
            }));
            // Un producto con variantes es UN trabajo: se crea el grupo entero, la IA lo completa una sola vez y se publica junto.
            for (const { grupo: g, urls } of gruposListos) {
                const primera = g.filas[0];
                trabajos.push({
                    tipo: 'grupo',
                    parentSku: g.codigo,
                    // Nombre, descripción y canales son del producto: se toman de la primera fila que los tenga.
                    productName: g.filas.map((f) => f.nombre).find(Boolean) ?? '',
                    description: g.filas.map((f) => f.descripcion).find(Boolean) ?? '',
                    targetMarketplaces: primera.canales,
                    publishTo: primera.canales.filter(t => conectados.includes(t)),
                    axes: g.ejes,
                    variants: g.filas.map((f, k) => ({
                        sku: f.sku, values: g.valores[k], price: f.precio, stock: f.stock,
                        salePrice: f.precioDescuento, saleStartDate: f.desde, saleEndDate: f.hasta, images: urls[k],
                    })),
                    ...comun,
                });
            }
            // El lote queda anotado en la base (con lo necesario para reintentar cada producto) antes de encolar.
            if (batchTotal) await this.bulkBatch.crear(batchId, req.user.id, storeId, trabajos.flatMap(renglonesDelTrabajo), rechazos, nombreDelExcel(excelFile.originalname));
            for (const trabajo of trabajos) {
                await this.listingsQueue.add(trabajo.tipo === 'grupo' ? 'process-group' : 'process-product', trabajo, OPCIONES_DE_TRABAJO);
            }

            return {
                message: `${batchTotal} productos encolados${gruposListos.length ? ` (${gruposListos.length} con variantes)` : ''}. ${rows.length - batchTotal} filas rechazadas.`,
                batchId: batchTotal ? batchId : undefined,
                totalQueued: batchTotal,
                totalSkipped: rows.length - batchTotal,
                ...(gruposListos.length && { gruposConVariantes: gruposListos.map((x) => ({ sku_padre: x.grupo.codigo, variantes: x.grupo.filas.length })) }),
                zipImagesLoaded: zipEntries.size,
                ...(rechazos.length && { rejectedDetails: rechazos }),
                ...(skusGenerados.length && { skusGenerados }),
            };
        } catch (error) {
            if (error instanceof BadRequestException) throw error;
            throw new BadRequestException('Error al leer el archivo Excel.');
        }
    }

    // ─────────────────────────────────────────────────────────────
    // POST /bulk-upload/products/edit — Bulk EDIT own products
    // ─────────────────────────────────────────────────────────────
    @Get('products/batches')
    @UseGuards(StoreAccessGuard)
    @RequirePermission('productos.editar')
    @ApiOperation({ summary: 'Historial de las cargas masivas que subiste en la tienda, con cómo va cada una' })
    async historialDeCargas(@Req() req) {
        return { cargas: await this.bulkBatch.historial(req.user.id, req.store?.storeId) };
    }

    @Get('products/batches/:batchId')
    @UseGuards(StoreAccessGuard)
    @RequirePermission('productos.editar')
    @ApiOperation({ summary: 'Los productos de una carga masiva, uno por uno' })
    async productosDeUnaCarga(@Param('batchId', ParseUUIDPipe) batchId: string, @Req() req) {
        const productos = await this.bulkBatch.productosDeLaCarga(batchId, req.user.id);
        if (!productos) throw new NotFoundException('No se encontró esa carga.');
        return { productos };
    }

    @Get('products/progress/:batchId')
    @UseGuards(StoreAccessGuard)
    @RequirePermission('productos.editar')
    @ApiOperation({ summary: 'Avance de una carga masiva de productos (cuántos van listos y cuántos fallaron)' })
    async progresoDeLaCarga(@Param('batchId') batchId: string, @Req() req) {
        // Redis lleva el avance en vivo; pasadas 24 h (o tras un reinicio) la respuesta sale del registro de la base.
        const enVivo = await this.batchNotification.progreso(batchId, req.user.id);
        const guardado = await this.bulkBatch.resumen(batchId, req.user.id);
        if (!enVivo && !guardado) throw new NotFoundException('No se encontró esa carga.');
        return {
            ...(enVivo ?? { total: guardado!.total, processed: guardado!.processed, failed: guardado!.failed, terminado: guardado!.terminado }),
            fallidos: guardado?.fallidos ?? [],
            rechazadas: guardado?.rechazadas ?? [],
            falabella: guardado?.falabella,
            falabellaRechazados: guardado?.falabellaRechazados ?? [],
            reintentados: guardado?.reintentados ?? 0,
        };
    }

    @Post('products/retry/:batchId')
    @UseGuards(StoreAccessGuard)
    @RequirePermission('productos.editar')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({ summary: 'Reintentar una carga masiva terminada: vuelve a mandar los productos fallidos (en un lote nuevo) y reenvía a Falabella los que quedaron sin enviar' })
    async reintentarCarga(@Param('batchId') batchId: string, @Req() req) {
        const lote = await this.bulkBatch.paraReintentar(batchId, req.user.id);
        if (!lote) throw new NotFoundException('No se encontró esa carga.');
        if (!lote.puedeReintentarse) throw new BadRequestException('Esa carga todavía está en proceso. Espera a que termine para reintentar.');
        if (!lote.fallidos.length && !lote.falabellaPendientes.length) throw new BadRequestException('Esa carga no tiene productos por reintentar.');

        let nuevoLote: string | undefined;
        if (lote.fallidos.length) {
            nuevoLote = randomUUID();
            // Un producto con variantes se reintenta entero: su primer renglón guarda el trabajo del grupo y los demás solo lo señalan.
            const completos = lote.fallidos.filter(({ payload }) => !payload?.grupoDe);
            const total = completos.reduce((n, { payload }) => n + productosDelTrabajo(payload), 0);
            await this.batchNotification.iniciar(nuevoLote, total, req.user.id);
            const trabajos: any[] = completos.map(({ payload }) => ({ ...payload, batchId: nuevoLote, batchTotal: total, reintento: true }));
            await this.bulkBatch.crear(nuevoLote, req.user.id, lote.storeId ?? undefined, trabajos.flatMap(renglonesDelTrabajo), [], lote.archivo ? `Reintento de ${lote.archivo.replace(/^Reintento de /, '')}` : 'Reintento');
            for (const trabajo of trabajos) {
                await this.listingsQueue.add(trabajo.tipo === 'grupo' ? 'process-group' : 'process-product', trabajo, OPCIONES_DE_TRABAJO);
            }
            await this.bulkBatch.marcarReintentados(batchId, lote.fallidos.map((f) => f.sku));
        }
        if (lote.falabellaPendientes.length && lote.payloadBase) {
            await this.listingsQueue.add('enviar-falabella', {
                batchId, userId: req.user.id, storeId: lote.storeId, productIds: lote.falabellaPendientes, cuentas: lote.payloadBase.cuentas,
            }, { attempts: 2, backoff: { type: 'exponential', delay: 60_000 } });
        }
        return {
            message: `${lote.fallidos.length} productos fallidos vueltos a encolar. ${lote.falabellaPendientes.length} reenviados a Falabella.`,
            batchId: nuevoLote,
            reintentados: lote.fallidos.length,
            falabellaReenviados: lote.falabellaPendientes.length,
        };
    }

    // ─────────────────────────────────────────────────────────────
    // Edición masiva con vista previa (por tienda; precio y stock pasan por el modo revisión)
    // ─────────────────────────────────────────────────────────────
    @Get('products/bulk-edit/template')
    @UseGuards(StoreAccessGuard)
    @RequirePermission('productos.editar')
    @ApiOperation({ summary: 'Excel con los productos actuales de la tienda (SKU, nombre, precio, stock), listo para editar y volver a subir' })
    async plantillaDeEdicion(@Req() req, @Res() res: Response) {
        const buffer = await this.edicionMasiva.plantilla(req.store.storeId);
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': 'attachment; filename="productos-para-editar.xlsx"',
        });
        return res.send(buffer);
    }

    @Post('products/bulk-edit/preview')
    @UseGuards(StoreAccessGuard)
    @RequirePermission('productos.editar')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Vista previa de la edición masiva: qué cambiaría en cada producto. No escribe nada.' })
    @ApiConsumes('multipart/form-data')
    @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
    @UseInterceptors(FileInterceptor('file'))
    async vistaPreviaDeEdicion(@UploadedFile() file: Express.Multer.File, @Req() req) {
        if (!file) throw new BadRequestException('El archivo Excel es obligatorio.');
        return this.edicionMasiva.procesar({ userId: req.user.id, storeId: req.store.storeId }, file.buffer, false, req.store.permissions.includes('inventario.editar'));
    }

    @Post('products/bulk-edit/apply')
    @UseGuards(StoreAccessGuard)
    @RequirePermission('productos.editar')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Aplica la edición masiva. Precio y stock siguen el modo revisión de la tienda (quedan pendientes de aprobar si está encendido).' })
    @ApiConsumes('multipart/form-data')
    @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
    @UseInterceptors(FileInterceptor('file'))
    async aplicarEdicion(@UploadedFile() file: Express.Multer.File, @Req() req) {
        if (!file) throw new BadRequestException('El archivo Excel es obligatorio.');
        return this.edicionMasiva.procesar({ userId: req.user.id, storeId: req.store.storeId }, file.buffer, true, req.store.permissions.includes('inventario.editar'));
    }

    @Post('products/edit')
    @UseGuards(StoreAccessGuard)
    @RequirePermission('productos.editar')
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
    @UseGuards(StoreAccessGuard)
    @RequirePermission('productos.editar')
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
