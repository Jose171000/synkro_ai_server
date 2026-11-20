import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { Product } from '../products/entities/product.entity';
import { SyncService } from '../sync/sync.service';
import { leerPrimeraHoja } from '../common/excel/excel';
import { MAX_DESCRIPCION, Cambio, FilaDeEdicion, calcularCambios, cambiaDescuento, cambiaInventario, columnasReconocidas, leerFilasDeEdicion } from './edicion-masiva';

export const MAX_FILAS_DE_EDICION = 5000;
const MUESTRA = 300;

export interface ResultadoDeEdicion {
    aplicado: boolean;
    totalFilas: number;
    conCambios: number;
    sinCambios: number;
    columnas: string[];
    noEncontrados: string[];
    errores: { sku: string; mensaje: string }[];
    /** Los primeros cambios, para revisarlos (todos se aplican igual). */
    cambios: { sku: string; nombre: string; cambios: Cambio[] }[];
    cambiosOmitidos: number;
    /** Solo al aplicar */
    actualizados?: number;
    enRevision?: number;
}

@Injectable()
export class EdicionMasivaService {
    constructor(
        @InjectRepository(Product) private readonly productos: Repository<Product>,
        private readonly sync: SyncService,
    ) {}

    /** Un Excel con los productos actuales de la tienda, listo para editar y volver a subir. */
    async plantilla(storeId: string): Promise<Buffer> {
        const lista = await this.productos.find({
            where: { store: { id: storeId } },
            select: { id: true, sku: true, name: true, price: true, stock: true, description: true },
            order: { name: 'ASC' },
            take: MAX_FILAS_DE_EDICION,
        });
        const libro = new ExcelJS.Workbook();
        const hoja = libro.addWorksheet('Productos');
        hoja.columns = [
            { header: 'SKU', key: 'sku', width: 22 },
            { header: 'Nombre', key: 'nombre', width: 50 },
            { header: 'Precio', key: 'precio', width: 12 },
            { header: 'Stock', key: 'stock', width: 10 },
            { header: 'Descripción', key: 'descripcion', width: 60 },
            { header: 'Descuento %', key: 'descPct', width: 14 },
            { header: 'Precio con descuento', key: 'descPrecio', width: 20 },
            { header: 'Descuento desde', key: 'descDesde', width: 16 },
            { header: 'Descuento hasta', key: 'descHasta', width: 16 },
            { header: 'Quitar descuento', key: 'descQuitar', width: 16 },
        ];
        hoja.getRow(1).font = { bold: true };
        hoja.views = [{ state: 'frozen', ySplit: 1 }];
        for (const p of lista) hoja.addRow({ sku: p.sku, nombre: p.name, precio: p.price == null ? null : Number(p.price), stock: p.stock, descripcion: (p.description ?? '').trim().length > MAX_DESCRIPCION ? null : (p.description ?? '').trim() || null });

        const ayuda = libro.addWorksheet('Cómo usar');
        [
            'Cambia solo lo que quieras en las columnas Nombre, Precio, Stock y Descripción y sube el archivo en Synkro.',
            'No cambies la columna SKU: es lo que identifica cada producto. Un SKU que no exista en esta tienda se ignora.',
            'Una celda vacía significa «no tocar». Puedes borrar las filas y columnas que no quieras editar.',
            'Descripción es la descripción de «Editar producto» (el dato de entrada para la IA); no es la ficha HTML. Cambiarla no envía nada a los canales ni regenera la ficha. Si una descripción pasa de ' + MAX_DESCRIPCION + ' caracteres, su celda va vacía (no se toca).',
            'DESCUENTO para todos los canales: escribe «Descuento %» (por ejemplo 15) o «Precio con descuento» (en soles), nunca los dos, y SIEMPRE «Descuento hasta» (fecha de fin; puede ser dentro de un año). «Descuento desde» es opcional (por defecto, hoy).',
            'Las fechas pueden ir como AAAA-MM-DD o DD/MM/AAAA. Para quitar un descuento escribe «sí» en «Quitar descuento».',
            'El descuento se envía a Falabella, Mercado Libre, WooCommerce y Ripley donde el producto esté publicado. Mercado Libre acepta de 5% a 80%; en Falabella un descuento ya enviado solo se quita en el Seller Center.',
            'Antes de aplicar, Synkro te muestra qué cambiaría en cada producto.',
            'Los cambios de precio y stock siguen las reglas de tu tienda: con el modo revisión encendido quedan pendientes de aprobar antes de llegar a los canales.',
        ].forEach((t) => ayuda.addRow([t]));
        ayuda.getColumn(1).width = 120;
        return Buffer.from(await libro.xlsx.writeBuffer());
    }

    async procesar(scope: { userId: string; storeId: string }, buffer: Buffer, aplicar: boolean, puedeEditarInventario: boolean): Promise<ResultadoDeEdicion> {
        let crudas: Record<string, any>[];
        try { crudas = await leerPrimeraHoja(buffer); } catch { throw new BadRequestException('No se pudo leer el archivo. Sube un Excel (.xlsx).'); }
        if (!crudas.length) throw new BadRequestException('El Excel está vacío.');
        if (crudas.length > MAX_FILAS_DE_EDICION) throw new BadRequestException(`El Excel tiene más de ${MAX_FILAS_DE_EDICION} filas. Divídelo en varios.`);
        const columnas = columnasReconocidas(crudas);
        if (!columnas.length) throw new BadRequestException('El Excel no trae ninguna columna para editar (Nombre, Precio, Stock, Descripción o Descuento).');

        const filas = leerFilasDeEdicion(crudas);
        const existentes = await this.productos.find({
            where: { store: { id: scope.storeId } },
            select: { id: true, sku: true, name: true, price: true, stock: true, description: true, salePrice: true, saleEndDate: true },
        });
        const porSku = new Map(existentes.map((p) => [p.sku.trim().toLowerCase(), p]));

        const r: ResultadoDeEdicion = { aplicado: aplicar, totalFilas: filas.length, conCambios: 0, sinCambios: 0, columnas, noEncontrados: [], errores: [], cambios: [], cambiosOmitidos: 0 };
        const pendientes: { producto: Product; fila: FilaDeEdicion; cambios: Cambio[] }[] = [];
        for (const fila of filas) {
            if (fila.errores.length) { r.errores.push({ sku: fila.sku || '(sin SKU)', mensaje: fila.errores.join(' ') }); continue; }
            const producto = porSku.get(fila.sku.trim().toLowerCase());
            if (!producto) { r.noEncontrados.push(fila.sku); continue; }
            let cambios: Cambio[];
            try { cambios = calcularCambios(fila, producto); } catch (error: any) { r.errores.push({ sku: fila.sku, mensaje: error?.message ?? 'El descuento no se puede aplicar.' }); continue; }
            if (!cambios.length) { r.sinCambios++; continue; }
            if ((cambiaInventario(cambios) || cambiaDescuento(cambios)) && !puedeEditarInventario) {
                r.errores.push({ sku: fila.sku, mensaje: 'Tu rol no puede cambiar precio, stock ni descuentos.' });
                continue;
            }
            r.conCambios++;
            if (r.cambios.length < MUESTRA) r.cambios.push({ sku: producto.sku, nombre: producto.name, cambios });
            else r.cambiosOmitidos++;
            pendientes.push({ producto, fila, cambios });
        }

        if (aplicar) {
            r.actualizados = 0;
            r.enRevision = 0;
            for (const { producto, fila, cambios } of pendientes) {
                try {
                    const texto: Partial<Product> = {};
                    if (cambios.some((c) => c.campo === 'nombre')) texto.name = fila.nombre!;
                    if (cambios.some((c) => c.campo === 'descripcion')) texto.description = fila.descripcion!;
                    if (Object.keys(texto).length) await this.productos.update({ id: producto.id }, texto);
                    if (cambiaInventario(cambios)) {
                        const dto: { stock?: number; price?: number } = {};
                        if (fila.stock !== undefined) dto.stock = fila.stock;
                        if (fila.precio !== undefined) dto.price = fila.precio;
                        const res: any = await this.sync.updateInventory(scope, producto.id, dto);
                        if (res && 'pending' in res && res.pending) r.enRevision!++;
                    }
                    // El descuento va después del precio: se calcula sobre el precio ya guardado.
                    if (cambiaDescuento(cambios)) {
                        const res: any = fila.quitarDescuento
                            ? await this.sync.quitarDescuentoGeneral(scope, [producto.id])
                            : await this.sync.aplicarDescuentoGeneral(scope, { productIds: [producto.id], ...fila.descuento! });
                        const fallo = res?.resultados?.find((x: any) => !x.ok);
                        if (fallo) throw new Error(fallo.message);
                    }
                    r.actualizados++;
                } catch (error: any) {
                    r.errores.push({ sku: producto.sku, mensaje: error?.message ?? 'No se pudo actualizar.' });
                }
            }
        }
        return r;
    }
}
