import * as ExcelJS from 'exceljs';

const NOMBRE_DE_CANAL: Record<string, string> = { falabella: 'Falabella', mercadolibre: 'Mercado Libre' };

/** Todas las combinaciones no vacías de los canales conectados: la lista desplegable de Excel no admite varias selecciones. */
export function combinacionesDeCanales(canales: string[]): string[] {
    const lista = [...new Set(canales)];
    const salida: string[] = [];
    for (let mascara = 1; mascara < 1 << lista.length; mascara++) {
        salida.push(lista.filter((_, i) => mascara & (1 << i)).join(','));
    }
    return salida.sort((a, b) => a.split(',').length - b.split(',').length);
}

/** Nombre de archivo seguro con el nombre de la tienda: «Maba Kids» → «plantilla-productos-maba-kids.xlsx». */
export function nombreDeArchivo(tienda: string): string {
    const limpio = String(tienda ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
    return `plantilla-productos${limpio ? `-${limpio}` : ''}.xlsx`;
}

/**
 * Plantilla de Excel para crear productos en lote en una tienda: la columna «canales» es una lista
 * desplegable con solo los canales que esa tienda tiene conectados.
 */
export async function plantillaDeProductos(tienda: string, canalesConectados: string[]): Promise<Buffer> {
    const libro = new ExcelJS.Workbook();
    libro.created = new Date();
    const hoja = libro.addWorksheet('Productos');

    hoja.columns = [
        { header: 'sku', key: 'sku', width: 16 },
        { header: 'precio', key: 'precio', width: 10 },
        { header: 'stock', key: 'stock', width: 8 },
        { header: 'fotos', key: 'fotos', width: 44 },
        { header: 'nombre', key: 'nombre', width: 36 },
        { header: 'descripcion', key: 'descripcion', width: 50 },
        { header: 'canales', key: 'canales', width: 26 },
        { header: 'precio_descuento', key: 'precio_descuento', width: 18 },
        { header: 'descuento_desde', key: 'descuento_desde', width: 16 },
        { header: 'descuento_hasta', key: 'descuento_hasta', width: 16 },
    ];
    hoja.getRow(1).font = { bold: true };
    hoja.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCCB34' } };
    hoja.views = [{ state: 'frozen', ySplit: 1 }];

    const combos = combinacionesDeCanales(canalesConectados);
    const ejemploCanales = combos.length ? combos[combos.length - 1] : '';
    hoja.addRow({ sku: 'EJEMPLO-1', precio: 250, stock: 10, fotos: 'fotos/EJEMPLO-1.jpg, fotos/EJEMPLO-1-2.jpg', nombre: '', descripcion: '', canales: ejemploCanales, precio_descuento: 199.9, descuento_desde: '2026-11-01', descuento_hasta: '2026-11-30' });
    hoja.addRow({ sku: 'EJEMPLO-2', precio: 89.9, stock: 25, fotos: '', nombre: 'Nombre corto (opcional)', descripcion: 'Texto opcional: refuerza lo que la IA ve en las fotos', canales: '' });

    // Lista desplegable de canales para las primeras 1000 filas (el texto de la lista no puede pasar de 255 caracteres).
    const opciones = combos.join(',');
    if (combos.length && opciones.length <= 250) {
        for (let fila = 2; fila <= 1001; fila++) {
            hoja.getCell(`G${fila}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [`"${opciones}"`],
                showErrorMessage: true,
                errorStyle: 'warning',
                errorTitle: 'Canal',
                error: `Esta tienda tiene conectado: ${canalesConectados.map(c => NOMBRE_DE_CANAL[c] ?? c).join(', ')}.`,
            };
        }
    }

    const guia = libro.addWorksheet('Instrucciones');
    guia.columns = [{ width: 110 }];
    const lineas = [
        `Plantilla de productos para la tienda: ${tienda}`,
        '',
        `Canales conectados en esta tienda: ${canalesConectados.length ? canalesConectados.map(c => NOMBRE_DE_CANAL[c] ?? c).join(', ') : 'ninguno (los productos se crean pero no se publican)'}.`,
        'Cada fila es un producto. Borra las filas EJEMPLO-1 y EJEMPLO-2 antes de subir el archivo.',
        '',
        'sku: obligatorio y único. No puede repetirse ni existir ya en tus productos.',
        'precio: obligatorio, en soles (250, 89.90).',
        'stock: opcional (vacío = 0).',
        'fotos: solo JPG. Rutas dentro del ZIP separadas por coma (fotos/MK-001.jpg, fotos/MK-001-2.jpg) o direcciones web.',
        '       Si la dejas vacía, la plataforma busca en el ZIP las fotos cuyo nombre empieza por el SKU (MK-001.jpg, MK-001-2.jpg) o que están en una carpeta con el SKU.',
        '       La primera foto es la principal. Máximo 8 por producto.',
        'nombre y descripcion: opcionales. Si faltan, la IA los arma a partir de las fotos.',
        'canales: elige de la lista. Si la dejas vacía se publica en todos los canales conectados.',
        'precio_descuento: opcional. Debe ser menor que el precio. Se envía a Falabella como precio con descuento.',
        'descuento_desde / descuento_hasta: opcionales, fechas AAAA-MM-DD (por ejemplo 2026-11-30). Sin fechas, el descuento queda sin vigencia definida.',
    ];
    lineas.forEach(l => guia.addRow([l]));
    guia.getRow(1).font = { bold: true, size: 13 };

    return Buffer.from(await libro.xlsx.writeBuffer());
}
