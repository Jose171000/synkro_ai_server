import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { Product } from '../products/entities/product.entity';
import { SyncService } from '../sync/sync.service';
import { leerPrimeraHoja } from '../common/excel/excel';
import { Cambio, FilaDeEdicion, calcularCambios, cambiaInventario, columnasReconocidas, leerFilasDeEdicion } from './edicion-masiva';

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
            select: { id: true, sku: true, name: true, price: true, stock: true },
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
        ];
        hoja.getRow(1).font = { bold: true };
        hoja.views = [{ state: 'frozen', ySplit: 1 }];
        for (const p of lista) hoja.addRow({ sku: p.sku, nombre: p.name, precio: p.price == null ? null : Number(p.price), stock: p.stock });

        const ayuda = libro.addWorksheet('Cómo usar');
        [
            'Cambia solo lo que quieras en las columnas Nombre, Precio y Stock y sube el archivo en Synkro.',
            'No cambies la columna SKU: es lo que identifica cada producto. Un SKU que no exista en esta tienda se ignora.',
            'Una celda vacía significa «no tocar». Puedes borrar las filas y columnas que no quieras editar.',
            'También puedes agregar una columna «Descripción» para cambiar la descripción.',
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
        if (!columnas.length) throw new BadRequestException('El Excel no trae ninguna columna para editar (Nombre, Precio, Stock o Descripción).');

        const filas = leerFilasDeEdicion(crudas);
        const existentes = await this.productos.find({
            where: { store: { id: scope.storeId } },
            select: { id: true, sku: true, name: true, price: true, stock: true, description: true },
        });
        const porSku = new Map(existentes.map((p) => [p.sku.trim().toLowerCase(), p]));

        const r: ResultadoDeEdicion = { aplicado: aplicar, totalFilas: filas.length, conCambios: 0, sinCambios: 0, columnas, noEncontrados: [], errores: [], cambios: [], cambiosOmitidos: 0 };
        const pendientes: { producto: Product; fila: FilaDeEdicion; cambios: Cambio[] }[] = [];
        for (const fila of filas) {
            if (fila.errores.length) { r.errores.push({ sku: fila.sku || '(sin SKU)', mensaje: fila.errores.join(' ') }); continue; }
            const producto = porSku.get(fila.sku.trim().toLowerCase());
            if (!producto) { r.noEncontrados.push(fila.sku); continue; }
            const cambios = calcularCambios(fila, producto);
            if (!cambios.length) { r.sinCambios++; continue; }
            if (cambiaInventario(cambios) && !puedeEditarInventario) {
                r.errores.push({ sku: fila.sku, mensaje: 'Tu rol no puede cambiar precio ni stock.' });
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
                    r.actualizados++;
                } catch (error: any) {
                    r.errores.push({ sku: producto.sku, mensaje: error?.message ?? 'No se pudo actualizar.' });
                }
            }
        }
        return r;
    }
}
