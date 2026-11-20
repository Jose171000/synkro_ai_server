import * as ExcelJS from 'exceljs';

const NOMBRE_DE_CANAL: Record<string, string> = { falabella: 'Falabella', mercadolibre: 'Mercado Libre', woocommerce: 'WooCommerce' };

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
        // Solo para productos con variantes (encabezado de otro color).
        { header: 'sku_padre', key: 'sku_padre', width: 16 },
        { header: 'eje_1', key: 'eje_1', width: 12 },
        { header: 'valor_1', key: 'valor_1', width: 14 },
        { header: 'eje_2', key: 'eje_2', width: 12 },
        { header: 'valor_2', key: 'valor_2', width: 14 },
        { header: 'eje_3', key: 'eje_3', width: 12 },
        { header: 'valor_3', key: 'valor_3', width: 14 },
    ];
    hoja.getRow(1).font = { bold: true };
    hoja.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCCB34' } };
    // Columnas de variantes: celeste, con una nota al pasar el mouse.
    for (let col = 11; col <= 17; col++) {
        hoja.getRow(1).getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBDD7EE' } };
    }
    hoja.getCell('K1').note = 'Solo para productos con variantes. Escribe el mismo sku_padre en todas las filas del producto; en eje_1 en qué se diferencian (Medida) y en valor_1 el valor de cada fila (2 plazas). Ver la hoja Instrucciones.';
    hoja.views = [{ state: 'frozen', ySplit: 1 }];

    const combos = combinacionesDeCanales(canalesConectados);
    const ejemploCanales = combos.length ? combos[combos.length - 1] : '';
    hoja.addRow({ sku: 'EJEMPLO-1', precio: 250, stock: 10, fotos: 'fotos/EJEMPLO-1.jpg, fotos/EJEMPLO-1-2.jpg', nombre: '', descripcion: '', canales: ejemploCanales, precio_descuento: 199.9, descuento_desde: '2026-11-01', descuento_hasta: '2026-11-30' });
    hoja.addRow({ sku: 'EJEMPLO-2', precio: 89.9, stock: 25, fotos: '', nombre: 'Nombre corto (opcional)', descripcion: 'Texto opcional: refuerza lo que la IA ve en las fotos', canales: '' });
    // Un producto con variantes: dos filas con el mismo sku_padre. El nombre del eje basta en la primera fila.
    hoja.addRow({ sku: 'EJEMPLO-3', precio: 699, stock: 8, fotos: 'fotos/EJEMPLO-3.jpg', nombre: 'Producto con variantes (opcional)', canales: ejemploCanales, sku_padre: 'EJEMPLO-GRUPO', eje_1: 'Medida', valor_1: '1.5 plazas', eje_2: 'Color', valor_2: 'Blanco' });
    hoja.addRow({ sku: 'EJEMPLO-4', precio: 899, stock: 4, fotos: '', sku_padre: 'EJEMPLO-GRUPO', valor_1: '2 plazas', valor_2: 'Blanco' });

    // Lista desplegable de canales para las primeras 1000 filas. Las opciones van en una hoja oculta: en una lista
    // escrita en la propia validación la coma separa opciones y «falabella,mercadolibre» se partiría en dos.
    if (combos.length) {
        const listas = libro.addWorksheet('Listas', { state: 'veryHidden' });
        combos.forEach((combo, i) => { listas.getCell(`A${i + 1}`).value = combo; });
        for (let fila = 2; fila <= 1001; fila++) {
            hoja.getCell(`G${fila}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [`Listas!$A$1:$A$${combos.length}`],
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
        'Cada fila es un producto (o una variante de un producto). Borra las filas EJEMPLO antes de subir el archivo.',
        '',
        'sku: opcional. Si lo dejas vacío, se asigna uno con el formato de tu tienda. Si lo escribes, no puede repetirse ni existir ya en la tienda.',
        '     Sin SKU escrito, las fotos de esa fila se indican en la columna fotos (la búsqueda por nombre de archivo necesita el SKU).',
        'precio: obligatorio, en soles (250, 89.90).',
        'stock: opcional (vacío = 0).',
        'fotos: solo JPG. Rutas dentro del ZIP separadas por coma (fotos/MK-001.jpg, fotos/MK-001-2.jpg) o direcciones web.',
        '       Si la dejas vacía, la plataforma busca en el ZIP las fotos cuyo nombre empieza por el SKU (MK-001.jpg, MK-001-2.jpg) o que están en una carpeta con el SKU.',
        '       La primera foto es la principal. Máximo 8 por producto.',
        'nombre y descripcion: opcionales. Si faltan, la IA los arma a partir de las fotos.',
        'canales: elige de la lista. Si la dejas vacía se usan los canales marcados en pantalla al subir el archivo (o todos los conectados, si no marcaste ninguno).',
        'precio_descuento: opcional. Debe ser menor que el precio. Se envía a Falabella como precio con descuento.',
        'descuento_hasta: obligatoria si hay precio_descuento: fecha de fin del descuento, AAAA-MM-DD (por ejemplo 2026-12-31). Falabella no acepta un descuento sin fechas.',
        'descuento_desde: opcional, AAAA-MM-DD. Si la dejas vacía, el descuento empieza el día de la carga.',
        '',
        'PRODUCTOS CON VARIANTES (columnas celestes; déjalas vacías si tu producto no tiene variantes)',
        'Cada fila es una variante que se vende, con su propio sku, precio, stock y fotos. Las filas con el mismo sku_padre forman UN producto con variantes,',
        'que se publica como una sola ficha donde el comprador elige la medida, el color, etc.',
        '',
        'sku_padre: el código del producto (en Falabella es el ParentSku). Escribe el mismo en todas sus filas. No puede ser el SKU de una variante ni de otro producto.',
        'eje_1, eje_2, eje_3: en qué se diferencian las variantes (Medida, Color, Talla, Sabor…). Basta escribirlos en la primera fila del producto.',
        'valor_1, valor_2, valor_3: el valor de cada fila para ese eje (2 plazas, Blanco…). Cada fila necesita un valor por cada eje.',
        'Para agregar un eje: escribe su nombre en la siguiente columna eje_ libre. Para agregar una variante: agrega otra fila con el mismo sku_padre.',
        'Ejemplo de un colchón en 3 medidas:',
        '   sku GOLD-15P | precio 699 | sku_padre GOLDEN-PREM | eje_1 Medida | valor_1 1.5 plazas',
        '   sku GOLD-2P  | precio 899 | sku_padre GOLDEN-PREM |              | valor_1 2 plazas',
        '   sku GOLD-QN  | precio 1099 | sku_padre GOLDEN-PREM |             | valor_1 Queen',
        'nombre, descripcion y canales: se toman de la primera fila del producto; en las demás puedes dejarlos vacíos. Sin nombre, la IA lo arma una vez para todo el producto.',
        'sku: si lo dejas vacío en una variante, se arma con el sku_padre y sus valores (GOLDEN-PREM-QUEEN).',
        'fotos: si una variante no tiene fotos, usa las de la primera fila del producto que tenga.',
        'Dos filas no pueden ser la misma variante (mismos valores). Límites: 3 ejes, 40 valores por eje y 100 variantes por producto.',
        'Si una fila de un producto con variantes tiene un error, ese producto no se crea (se crea completo o no se crea) y el motivo aparece en el resultado de la carga.',
        'Si escribes sku_padre sin ejes, las filas se crean como productos separados que solo comparten la categoría (como antes).',
    ];
    lineas.forEach(l => guia.addRow([l]));
    guia.getRow(1).font = { bold: true, size: 13 };

    return Buffer.from(await libro.xlsx.writeBuffer());
}
