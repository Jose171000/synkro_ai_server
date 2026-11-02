import * as ExcelJS from 'exceljs';
import { ESTADOS_DE_VENTA, EstadoDeVenta } from './estado-de-venta';

/**
 * Ventas de canales que la tienda NO tiene conectados (Ripley, Juntoz, WhatsApp, tienda física…): se registran a mano
 * o por Excel. Aquí viven las reglas puras: leer y validar las filas, y armar la plantilla.
 */

/** Canales que se ofrecen en la lista; se puede escribir cualquier otro. */
export const CANALES_SUGERIDOS = [
    { valor: 'ripley', nombre: 'Ripley' },
    { valor: 'juntoz', nombre: 'Juntoz' },
    { valor: 'amazon', nombre: 'Amazon' },
    { valor: 'whatsapp', nombre: 'WhatsApp' },
    { valor: 'tienda-fisica', nombre: 'Tienda física' },
    { valor: 'web-propia', nombre: 'Web propia' },
    { valor: 'otro', nombre: 'Otro' },
];

export interface LineaManual {
    /** El producto se identifica solo por su SKU del catálogo de la tienda. */
    sku: string;
    cantidad: number;
    /** Lo que pagó el cliente por unidad (sin envío). Sin valor, se usa el precio actual del catálogo. */
    precioUnitario: number | null;
    descontarStock: boolean;
}

export interface VentaManual {
    /** Número que el cliente conoce; con el mismo número no se registra dos veces. */
    numeroPedido: string | null;
    /** AAAA-MM-DD */
    fecha: string | null;
    canal: string;
    estado: EstadoDeVenta;
    /** Costo de envío cobrado: forma parte de lo pagado pero NO de la base de la comisión. */
    envio: number;
    cliente: string | null;
    telefono: string | null;
    documento: string | null;
    direccion: string | null;
    notas: string | null;
    moneda: string;
    lineas: LineaManual[];
}

const sinTildes = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** «Tienda física» → «tienda-fisica». Es lo que se guarda como canal de la venta. */
export function claveDeCanal(texto: unknown): string {
    const limpio = sinTildes(String(texto ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    return limpio;
}

/** Nombre para mostrar de un canal manual: el sugerido si lo es; si no, el texto con mayúscula inicial. */
export function nombreDeCanalManual(clave: string): string {
    const conocido = CANALES_SUGERIDOS.find(c => c.valor === clave);
    if (conocido) return conocido.nombre;
    const t = clave.replace(/-/g, ' ');
    return t.charAt(0).toUpperCase() + t.slice(1);
}

function texto(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    const t = String(v).trim();
    return t ? t : null;
}

function numero(v: unknown): number | null {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const limpio = String(v).replace(/[^\d.,-]/g, '');
    if (!/\d/.test(limpio)) return null;
    // «1.234,50» o «1,234.50»: el último separador es el decimal.
    const coma = limpio.lastIndexOf(','), punto = limpio.lastIndexOf('.');
    const normal = coma > punto ? limpio.replace(/\./g, '').replace(',', '.') : limpio.replace(/,/g, '');
    const n = Number(normal);
    return Number.isFinite(n) ? n : null;
}

/** Fecha como AAAA-MM-DD a partir de lo que trae Excel (fecha, «2026-10-05» o «05/10/2026»). */
export function leerFechaManual(v: unknown): string | null | 'invalida' {
    if (v === undefined || v === null || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'invalida' : v.toISOString().slice(0, 10);
    const t = String(v).trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return valida(+m[1], +m[2], +m[3]);
    m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) return valida(+m[3], +m[2], +m[1]);
    return 'invalida';
}

function valida(a: number, m: number, d: number): string | 'invalida' {
    const f = new Date(Date.UTC(a, m - 1, d));
    if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return 'invalida';
    return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function leerEstadoManual(v: unknown): EstadoDeVenta | null | 'invalido' {
    const t = texto(v);
    if (!t) return null;
    const e = sinTildes(t).toLowerCase().replace(/s$/, '');
    const hallado = ESTADOS_DE_VENTA.find(x => x === e);
    return hallado ?? 'invalido';
}

/** Los encabezados se aceptan con mayúsculas, tildes o espacios: «Precio unitario» = precio_unitario. */
function clavesDeFila(fila: Record<string, any>): Record<string, any> {
    const salida: Record<string, any> = {};
    for (const [k, v] of Object.entries(fila)) salida[sinTildes(k).toLowerCase().trim().replace(/[\s-]+/g, '_')] = v;
    return salida;
}

export interface LecturaDeFilas {
    ventas: VentaManual[];
    /** Una línea por fila con problema, con su número de fila de Excel. */
    errores: string[];
}

/**
 * Convierte las filas del Excel en ventas. Las filas con el mismo numero_pedido son líneas de una misma venta (los
 * datos del pedido se toman de la primera); una fila sin número es una venta aparte.
 */
export function ventasDeFilas(filas: Record<string, any>[]): LecturaDeFilas {
    const errores: string[] = [];
    const porNumero = new Map<string, VentaManual>();
    const ventas: VentaManual[] = [];

    filas.forEach((cruda, i) => {
        const f = clavesDeFila(cruda);
        const fila = i + 2; // la 1 es el encabezado
        const falla = (motivo: string) => errores.push(`Fila ${fila}: ${motivo}`);

        const sku = texto(f.sku);
        if (!sku) return falla('falta el sku.');
        const precioCrudo = f.precio_unitario ?? f.precio;
        const precio = numero(precioCrudo);
        // Vacío = precio actual del catálogo; si escribió algo, tiene que ser un número válido.
        if (texto(precioCrudo) !== null && (precio === null || precio < 0)) return falla('el precio_unitario debe ser un número (lo que pagó el cliente por unidad, sin envío).');
        const cantidadCruda = numero(f.cantidad);
        const cantidad = cantidadCruda === null ? 1 : cantidadCruda;
        if (!Number.isInteger(cantidad) || cantidad < 1) return falla('la cantidad debe ser un número entero de 1 o más.');
        const descontarTxt = (texto(f.descontar_stock) ?? 'si').toLowerCase();
        const descontarStock = !['no', 'n', '0', 'false'].includes(sinTildes(descontarTxt));

        const linea: LineaManual = { sku, cantidad, precioUnitario: precio, descontarStock };
        const numeroPedido = texto(f.numero_pedido);
        const existente = numeroPedido ? porNumero.get(numeroPedido.toLowerCase()) : undefined;
        if (existente) { existente.lineas.push(linea); return; }

        const canal = claveDeCanal(f.canal);
        if (!canal) return falla('falta el canal (por ejemplo Ripley, WhatsApp o Tienda física).');
        const fecha = leerFechaManual(f.fecha);
        if (fecha === 'invalida') return falla('la fecha debe ser AAAA-MM-DD (por ejemplo 2026-10-25).');
        const estado = leerEstadoManual(f.estado);
        if (estado === 'invalido') return falla(`el estado debe ser uno de: ${ESTADOS_DE_VENTA.join(', ')}.`);
        const envio = numero(f.envio) ?? 0;
        if (envio < 0) return falla('el envío no puede ser negativo.');

        const venta: VentaManual = {
            numeroPedido,
            fecha,
            canal,
            estado: estado ?? 'entregado',
            envio,
            cliente: texto(f.cliente),
            telefono: texto(f.telefono),
            documento: texto(f.documento),
            direccion: texto(f.direccion),
            notas: texto(f.notas),
            moneda: (texto(f.moneda) ?? 'PEN').toUpperCase().slice(0, 5),
            lineas: [linea],
        };
        ventas.push(venta);
        if (numeroPedido) porNumero.set(numeroPedido.toLowerCase(), venta);
    });
    return { ventas, errores };
}

/** Plantilla de Excel para registrar ventas de canales no conectados. */
export async function plantillaDeVentas(tienda: string): Promise<Buffer> {
    const libro = new ExcelJS.Workbook();
    libro.created = new Date();
    const hoja = libro.addWorksheet('Ventas');
    hoja.columns = [
        { header: 'numero_pedido', key: 'numero_pedido', width: 16 },
        { header: 'fecha', key: 'fecha', width: 12 },
        { header: 'canal', key: 'canal', width: 16 },
        { header: 'sku', key: 'sku', width: 16 },
        { header: 'cantidad', key: 'cantidad', width: 10 },
        { header: 'precio_unitario', key: 'precio_unitario', width: 16 },
        { header: 'envio', key: 'envio', width: 10 },
        { header: 'estado', key: 'estado', width: 12 },
        { header: 'cliente', key: 'cliente', width: 24 },
        { header: 'telefono', key: 'telefono', width: 14 },
        { header: 'documento', key: 'documento', width: 14 },
        { header: 'direccion', key: 'direccion', width: 30 },
        { header: 'notas', key: 'notas', width: 26 },
        { header: 'descontar_stock', key: 'descontar_stock', width: 16 },
        { header: 'moneda', key: 'moneda', width: 8 },
    ];
    hoja.getRow(1).font = { bold: true };
    hoja.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCCB34' } };
    hoja.views = [{ state: 'frozen', ySplit: 1 }];
    hoja.addRow({ numero_pedido: 'R-1001', fecha: '2026-10-25', canal: 'Ripley', sku: 'EJEMPLO-1', cantidad: 2, precio_unitario: 89.9, envio: 10, estado: 'entregado', cliente: 'Ana Pérez', telefono: '999888777', documento: '12345678', direccion: 'Av. Primavera 123, Surco', notas: '', descontar_stock: 'SI', moneda: 'PEN' });
    hoja.addRow({ numero_pedido: 'R-1001', sku: 'EJEMPLO-2', cantidad: 1, precio_unitario: 45 });
    hoja.addRow({ numero_pedido: '', fecha: '2026-10-26', canal: 'WhatsApp', sku: 'EJEMPLO-3', cantidad: 1, estado: 'enviado', cliente: 'Luis Soto', descontar_stock: 'NO' });

    // Listas desplegables (primeras 1000 filas): canal (se puede escribir otro) y estado.
    const listas = libro.addWorksheet('Listas', { state: 'veryHidden' });
    CANALES_SUGERIDOS.forEach((c, i) => { listas.getCell(`A${i + 1}`).value = c.nombre; });
    ESTADOS_DE_VENTA.forEach((e, i) => { listas.getCell(`B${i + 1}`).value = e; });
    ['SI', 'NO'].forEach((v, i) => { listas.getCell(`C${i + 1}`).value = v; });
    for (let fila = 2; fila <= 1001; fila++) {
        hoja.getCell(`C${fila}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`Listas!$A$1:$A$${CANALES_SUGERIDOS.length}`], showErrorMessage: false };
        hoja.getCell(`I${fila}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`Listas!$B$1:$B$${ESTADOS_DE_VENTA.length}`], showErrorMessage: true, errorTitle: 'Estado', error: `Usa: ${ESTADOS_DE_VENTA.join(', ')}.` };
        hoja.getCell(`O${fila}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['Listas!$C$1:$C$2'], showErrorMessage: true, errorTitle: 'Descontar stock', error: 'Usa SI o NO.' };
    }

    const guia = libro.addWorksheet('Instrucciones');
    guia.columns = [{ width: 112 }];
    [
        `Plantilla de ventas para la tienda: ${tienda}`,
        '',
        'Sirve para ventas de canales que NO tienes conectados en Synkro (Ripley, Juntoz, Amazon, WhatsApp, tienda física…).',
        'Las ventas de Mercado Libre y Falabella conectados entran solas: no las registres aquí.',
        'Borra las filas de ejemplo antes de subir el archivo.',
        '',
        'numero_pedido: opcional. Varias filas con el mismo número son productos de una misma venta (los datos del pedido se toman de la primera fila).',
        '     Con número, la venta no se puede registrar dos veces. Sin número, cada fila es una venta.',
        'fecha: AAAA-MM-DD (2026-10-25). Vacía = hoy.',
        'canal: obligatorio. Elige de la lista o escribe el que quieras. Aparece así en Ventas y en Analíticas.',
        'sku: obligatorio. El producto se identifica solo por su SKU del catálogo de la tienda (da igual mayúsculas o minúsculas). Un SKU que no esté en el catálogo se rechaza.',
        'cantidad: entero, 1 si la dejas vacía.',
        'precio_unitario: lo que pagó el cliente por UNA unidad, sin el envío. Si lo dejas vacío se usa el precio actual del producto en el catálogo.',
        'envio: lo cobrado por envío. Se suma a lo pagado, pero NO cuenta para la comisión de la agencia.',
        `estado: ${ESTADOS_DE_VENTA.join(', ')}. Vacío = entregado. Cancelado y devuelto no cuentan como venta ni descuentan stock.`,
        'descontar_stock: SI (por defecto) baja el stock del producto y lo actualiza en los canales conectados. NO deja el stock como está',
        '     (úsalo para ventas antiguas que ya están reflejadas en tu stock actual).',
        'moneda: PEN por defecto.',
    ].forEach(l => guia.addRow([l]));
    return Buffer.from(await libro.xlsx.writeBuffer());
}
