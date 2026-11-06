import axios from 'axios';
import ExcelJS = require('exceljs');
import PDFDocument = require('pdfkit');
import { EstadoDeStock, CriterioDeOrden } from './productos-ganadores';
import { ProductosGanadoresInforme, ProductoGanador } from './reports.service';

/**
 * Reporte descargable de Analíticas, en Excel (para trabajar los datos) y en PDF (para verlo: gráficos y fotos).
 * Recibe ya calculado lo mismo que muestra la pantalla: ventas del periodo y productos ganadores.
 */
export interface DatosDelReporte {
    tienda: string;
    generado: Date;
    ventas: {
        range: { from: string; to: string };
        totals: { sales: number; orders: number; avgTicket: number };
        byDay: { date: string; sales: number; orders: number }[];
        byChannel: { channel: string; sales: number; orders: number }[];
        byAccount?: { channel: string; label: string | null; sales: number; orders: number }[];
        includeShipping: boolean;
    };
    ganadores: ProductosGanadoresInforme;
    estados: string[];
}

const CANALES: Record<string, string> = {
    mercadolibre: 'Mercado Libre', shopify: 'Shopify', amazon: 'Amazon', woocommerce: 'WooCommerce', falabella: 'Falabella', ripley: 'Ripley',
    juntoz: 'Juntoz', tiendanube: 'Tiendanube', vtex: 'VTEX', yavendio: 'Yavendió', sheets: 'Otros canales',
};
export const nombreDeCanal = (id: string) => CANALES[id] ?? id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

const ESTADOS_DE_VENTA: Record<string, string> = { pendiente: 'Pendientes', enviado: 'Enviados', entregado: 'Entregados', cancelado: 'Cancelados', devuelto: 'Devueltos' };
const ORDEN: Record<CriterioDeOrden, string> = { units: 'Unidades vendidas', revenue: 'Ingresos', days: 'Se agota antes' };
const ESTADO_DE_STOCK: Record<EstadoDeStock, string> = {
    agotado: 'Agotado', critico: 'Crítico', pronto: 'Pronto', suficiente: 'Suficiente', sin_ventas: 'Sin ventas',
};
// [texto, fondo] en hex sin «#» (Excel) y con «#» para el PDF se arma abajo.
const COLOR_DE_STOCK: Record<EstadoDeStock, [string, string]> = {
    agotado: ['991B1B', 'FEE2E2'], critico: ['C62828', 'FDECEA'], pronto: ['B26A00', 'FFF4E0'], suficiente: ['2E7D32', 'E8F5E9'], sin_ventas: ['666666', 'F0F0F0'],
};

const dinero = (n: number) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const entero = (n: number) => Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: 0 });
const diasTexto = (g: ProductoGanador) => {
    const e = g.estimate;
    if (e.estado === 'agotado') return 'Agotado';
    if (e.estado === 'sin_ventas' || e.dias == null) return 'Sin ventas';
    return e.dias < 1 ? 'Menos de 1 día' : `${Math.round(e.dias)} ${Math.round(e.dias) === 1 ? 'día' : 'días'}`;
};
const periodoTexto = (d: DatosDelReporte) => (d.ventas.range.from === d.ventas.range.to ? d.ventas.range.from : `${d.ventas.range.from} al ${d.ventas.range.to}`);
const filtroTexto = (d: DatosDelReporte) => (d.estados.length ? d.estados.map((e) => ESTADOS_DE_VENTA[e] ?? e).join(', ') : 'Ventas concretadas (sin canceladas ni devueltas)');

// ── Fotos ────────────────────────────────────────────────────────────────

export interface Foto { buffer: Buffer; tipo: 'png' | 'jpeg' }

/** Solo https y nombres de sitio (nada de direcciones internas): las fotos son de los canales del vendedor. */
const urlSegura = (u: string) => {
    try {
        const x = new URL(u);
        return x.protocol === 'https:' && !/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[.*\])$/i.test(x.hostname) && x.hostname.includes('.');
    } catch { return false; }
};

const esJpeg = (b: Buffer) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8;
const esPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

/**
 * Miniatura lista para PDF y Excel. Los canales sirven muchas fotos en WebP (Falabella, Mercado Libre), que ni el PDF ni el Excel
 * aceptan: con `sharp` se convierten a JPG y se reducen (así el archivo también pesa poco). Sin `sharp` solo valen JPG y PNG.
 */
async function aMiniatura(original: Buffer): Promise<Foto | null> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sharp = require('sharp');
        const buffer: Buffer = await sharp(original).resize(120, 120, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 78 }).toBuffer();
        return { buffer, tipo: 'jpeg' };
    } catch {
        if (esJpeg(original)) return { buffer: original, tipo: 'jpeg' };
        if (esPng(original)) return { buffer: original, tipo: 'png' };
        return null;
    }
}

/**
 * Baja las fotos de los productos para ponerlas en el reporte. PDF y Excel solo aceptan JPG y PNG: el resto se convierte (ver aMiniatura) o se deja sin foto.
 * Si una foto falla o tarda, el reporte sale igual, sin esa foto.
 */
export async function descargarFotos(urls: (string | null)[], tiempoMs = 4000): Promise<Map<string, Foto>> {
    const unicas = [...new Set(urls.filter((u): u is string => !!u && urlSegura(u)))];
    const fotos = new Map<string, Foto>();
    let siguiente = 0;
    const trabajador = async () => {
        while (siguiente < unicas.length) {
            const url = unicas[siguiente++];
            try {
                const r = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: tiempoMs, maxContentLength: 2_000_000, maxRedirects: 3, validateStatus: (s) => s === 200 });
                const original = Buffer.from(r.data);
                const miniatura = await aMiniatura(original);
                if (miniatura) fotos.set(url, miniatura);
            } catch { /* sin foto */ }
        }
    };
    await Promise.all(Array.from({ length: 6 }, trabajador));
    return fotos;
}

// ── Excel ────────────────────────────────────────────────────────────────

const AMARILLO_XL = 'FFFCCB34';
const encabezado = (fila: ExcelJS.Row) => {
    fila.font = { bold: true, color: { argb: 'FF111111' } };
    fila.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMARILLO_XL } };
        c.alignment = { vertical: 'middle', wrapText: true };
    });
    fila.height = 22;
};

export async function reporteAExcel(d: DatosDelReporte, fotos: Map<string, Foto> = new Map()): Promise<Buffer> {
    const libro = new ExcelJS.Workbook();
    libro.creator = 'Synkro AI';
    libro.created = d.generado;

    // Resumen
    const resumen = libro.addWorksheet('Resumen', { views: [{ showGridLines: false }] });
    resumen.columns = [{ width: 30 }, { width: 44 }];
    resumen.mergeCells('A1:B1');
    resumen.getCell('A1').value = 'Reporte de analíticas - Synkro';
    resumen.getCell('A1').font = { bold: true, size: 16 };
    const datos: [string, string | number][] = [
        ['Tienda', d.tienda],
        ['Periodo', periodoTexto(d)],
        ['Ventas incluidas', filtroTexto(d)],
        ['Las ventas incluyen el envío', d.ventas.includeShipping ? 'Sí' : 'No (solo el precio de los productos)'],
        ['Generado', d.generado.toLocaleString('es-PE', { timeZone: 'America/Lima' }) + ' (hora de Lima)'],
        ['', ''],
        ['Ventas del periodo', d.ventas.totals.sales],
        ['Pedidos', d.ventas.totals.orders],
        ['Ticket promedio', d.ventas.totals.avgTicket],
        ['Productos distintos vendidos', d.ganadores.totals.products],
        ['Unidades vendidas', d.ganadores.totals.units],
    ];
    datos.forEach(([k, v], i) => {
        const fila = resumen.getRow(3 + i);
        fila.getCell(1).value = k;
        fila.getCell(1).font = { color: { argb: 'FF666666' } };
        fila.getCell(2).value = v;
        fila.getCell(2).font = { bold: true };
        fila.getCell(2).alignment = { horizontal: 'left' };
    });
    for (const r of [9, 11]) resumen.getCell(`B${r}`).numFmt = '"S/" #,##0.00';
    resumen.getCell('B10').numFmt = '#,##0';

    // Por día
    const dias = libro.addWorksheet('Ventas por día', { views: [{ state: 'frozen', ySplit: 1 }] });
    dias.columns = [{ header: 'Fecha', width: 14 }, { header: 'Ventas (S/)', width: 16, style: { numFmt: '#,##0.00' } }, { header: 'Pedidos', width: 12 }];
    encabezado(dias.getRow(1));
    d.ventas.byDay.forEach((x) => dias.addRow([x.date, x.sales, x.orders]));

    // Por canal y cuenta
    const canales = libro.addWorksheet('Canales y cuentas', { views: [{ state: 'frozen', ySplit: 1 }] });
    canales.columns = [{ header: 'Canal', width: 22 }, { header: 'Cuenta', width: 30 }, { header: 'Ventas (S/)', width: 16, style: { numFmt: '#,##0.00' } }, { header: 'Pedidos', width: 12 }, { header: '% de las ventas', width: 16, style: { numFmt: '0.0%' } }];
    encabezado(canales.getRow(1));
    const total = d.ventas.totals.sales || 0;
    if (d.ventas.byAccount?.length) d.ventas.byAccount.forEach((a) => canales.addRow([nombreDeCanal(a.channel), a.label ?? '', a.sales, a.orders, total ? a.sales / total : 0]));
    else d.ventas.byChannel.forEach((c) => canales.addRow([nombreDeCanal(c.channel), '', c.sales, c.orders, total ? c.sales / total : 0]));

    // Productos ganadores
    const g = libro.addWorksheet('Productos ganadores', { views: [{ state: 'frozen', ySplit: 1, xSplit: 3 }] });
    g.columns = [
        { header: '#', width: 5 }, { header: 'Foto', width: 9 }, { header: 'Producto', width: 46 }, { header: 'SKU', width: 18 },
        { header: 'Unidades vendidas', width: 12, style: { numFmt: '#,##0' } },
        { header: 'Ingresos (S/)', width: 15, style: { numFmt: '#,##0.00' } },
        { header: '% de ingresos', width: 12, style: { numFmt: '0.0"%"' } },
        { header: 'Pedidos', width: 10 },
        { header: 'Stock en Synkro', width: 12, style: { numFmt: '#,##0' } },
        { header: 'Ventas por día (30 días)', width: 14, style: { numFmt: '0.00' } },
        { header: 'Se agota en (días)', width: 13, style: { numFmt: '0.0' } },
        { header: 'Fecha estimada', width: 14 },
        { header: 'Estado del stock', width: 14 },
        { header: 'Recomendación', width: 22 },
        { header: 'Reponer para 30 días (u.)', width: 14, style: { numFmt: '#,##0' } },
    ];
    encabezado(g.getRow(1));
    g.getRow(1).height = 36;
    d.ganadores.items.forEach((x, i) => {
        const fila = g.addRow([
            i + 1, '', x.variant ? `${x.name} - ${x.variant}` : x.name, x.sku ?? '', x.units, x.revenue, x.share, x.orders,
            x.stock ?? '', x.estimate.porDia, x.estimate.dias ?? '', x.estimate.agotaEl ?? '', ESTADO_DE_STOCK[x.estimate.estado], x.estimate.recomendacion, x.estimate.sugerido,
        ]);
        fila.height = 40;
        fila.alignment = { vertical: 'middle' };
        fila.getCell(3).alignment = { vertical: 'middle', wrapText: true };
        const [texto, fondo] = COLOR_DE_STOCK[x.estimate.estado];
        for (const col of [13, 14]) {
            const c = fila.getCell(col);
            c.font = { bold: true, color: { argb: `FF${texto}` } };
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${fondo}` } };
        }
        const foto = x.imageUrl ? fotos.get(x.imageUrl) : undefined;
        if (foto) {
            try {
                const id = libro.addImage({ buffer: foto.buffer as any, extension: foto.tipo });
                g.addImage(id, { tl: { col: 1.1, row: fila.number - 1 + 0.1 }, ext: { width: 44, height: 44 } });
            } catch { /* sin foto */ }
        }
    });
    g.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 15 } };
    const nota = g.addRow([]);
    nota.getCell(3).value = 'El tiempo en que se agota usa las ventas de los últimos 30 días y el stock que tiene Synkro (cada canal puede tener otro número).';
    nota.getCell(3).font = { italic: true, color: { argb: 'FF666666' } };

    return Buffer.from(await libro.xlsx.writeBuffer());
}

// ── PDF ──────────────────────────────────────────────────────────────────

const ANCHO = 595.28;
const ALTO = 841.89;
const M = 36;
const UTIL = ANCHO - 2 * M;
const PIE = 28;
const AMARILLO = '#FCCB34';
const TINTA = '#111111';
const GRIS = '#666666';
const SUAVE = '#F4F4F4';
const LINEA = '#E3E3E3';
const seguro = (t: unknown) => String(t ?? '').replace(/[^\x20-\x7E -ÿ–—‘-”•…›]/g, '?');
const hex = (c: string) => `#${c}`;

export function reporteAPdf(d: DatosDelReporte, fotos: Map<string, Foto> = new Map()): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: 'Reporte de analíticas - Synkro', Author: 'Synkro AI' } });
        const trozos: Buffer[] = [];
        doc.on('data', (t: Buffer) => trozos.push(t));
        doc.on('end', () => resolve(Buffer.concat(trozos)));
        doc.on('error', reject);

        let y = 0;
        const asegurar = (alto: number) => { if (y + alto > ALTO - M - PIE) { doc.addPage(); y = M; } };
        const texto = (t: unknown, x: number, yy: number, o: { w?: number; size?: number; bold?: boolean; color?: string; align?: 'left' | 'right' | 'center' } = {}) => {
            doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size ?? 9).fillColor(o.color ?? TINTA);
            doc.text(seguro(t), x, yy, { width: o.w ?? UTIL, align: o.align ?? 'left', lineBreak: false, ellipsis: true, height: (o.size ?? 9) + 2 });
        };
        const titulo = (t: string, ayuda?: string) => {
            asegurar(ayuda ? 44 : 30);
            texto(t, M, y, { size: 12, bold: true });
            y += 17;
            if (ayuda) { texto(ayuda, M, y, { size: 8, color: GRIS }); y += 14; }
        };

        // Cabecera
        doc.rect(0, 0, ANCHO, 78).fill(AMARILLO);
        texto('SYNKRO', M, 20, { size: 10, bold: true });
        texto('Reporte de analíticas', M, 34, { size: 20, bold: true });
        texto(`${d.tienda} · ${periodoTexto(d)} · hora de Lima`, M, 59, { size: 9 });
        y = 94;
        texto(`Ventas incluidas: ${filtroTexto(d)}${d.ventas.includeShipping ? ' · con envío' : ' · solo el precio de los productos'}`, M, y, { size: 8, color: GRIS });
        y += 20;

        // Indicadores
        const tarjetas: [string, string][] = [['Ventas del periodo', dinero(d.ventas.totals.sales)], ['Pedidos', entero(d.ventas.totals.orders)], ['Ticket promedio', dinero(d.ventas.totals.avgTicket)]];
        const w = (UTIL - 16) / 3;
        tarjetas.forEach(([k, v], i) => {
            const x = M + i * (w + 8);
            doc.roundedRect(x, y, w, 52, 6).fill(SUAVE);
            texto(k, x + 10, y + 10, { size: 8, color: GRIS, w: w - 20 });
            texto(v, x + 10, y + 27, { size: 16, bold: true, w: w - 20 });
        });
        y += 70;

        // Evolución de ventas
        titulo('Evolución de ventas', 'Ventas por día del periodo');
        const dias = d.ventas.byDay;
        const alto = 120;
        const x0 = M + 44;
        const ancho = UTIL - 52;
        asegurar(alto + 30);
        const maximo = Math.max(1, ...dias.map((p) => p.sales));
        const techo = (() => { const e = Math.pow(10, Math.floor(Math.log10(maximo))); return Math.ceil(maximo / e) * e; })();
        for (let k = 0; k <= 4; k++) {
            const yy = y + alto - (alto * k) / 4;
            doc.moveTo(x0, yy).lineTo(x0 + ancho, yy).lineWidth(0.5).strokeColor(LINEA).stroke();
            texto(`S/ ${entero((techo * k) / 4)}`, M, yy - 4, { size: 7, color: GRIS, w: 40, align: 'right' });
        }
        if (dias.length) {
            const px = (i: number) => x0 + (dias.length === 1 ? ancho / 2 : (ancho * i) / (dias.length - 1));
            const py = (v: number) => y + alto - (alto * v) / techo;
            doc.moveTo(px(0), y + alto);
            dias.forEach((p, i) => doc.lineTo(px(i), py(p.sales)));
            doc.lineTo(px(dias.length - 1), y + alto).closePath().fillOpacity(0.35).fill(AMARILLO);
            doc.fillOpacity(1);
            doc.moveTo(px(0), py(dias[0].sales));
            dias.forEach((p, i) => doc.lineTo(px(i), py(p.sales)));
            doc.lineWidth(1.6).strokeColor('#D9A400').stroke();
            const pasos = Math.min(dias.length, 6);
            for (let k = 0; k < pasos; k++) {
                const i = pasos === 1 ? 0 : Math.round(((dias.length - 1) * k) / (pasos - 1));
                const [, m, dd] = dias[i].date.split('-');
                texto(`${dd}/${m}`, px(i) - 14, y + alto + 5, { size: 7, color: GRIS, w: 28, align: 'center' });
            }
        } else {
            texto('Sin ventas en este periodo', x0, y + alto / 2 - 4, { size: 9, color: GRIS, w: ancho, align: 'center' });
        }
        y += alto + 26;

        // Por canal
        if (d.ventas.byChannel.length) {
            const maxCanal = Math.max(1, ...d.ventas.byChannel.map((c) => c.sales));
            titulo('Ventas por canal');
            for (const c of d.ventas.byChannel.slice(0, 10)) {
                asegurar(20);
                texto(nombreDeCanal(c.channel), M, y + 2, { size: 9, w: 100 });
                const largo = Math.max(2, ((UTIL - 230) * c.sales) / maxCanal);
                doc.roundedRect(M + 104, y, largo, 12, 3).fill(AMARILLO);
                texto(`${dinero(c.sales)} · ${entero(c.orders)} pedidos`, M + 110 + largo, y + 2, { size: 8, color: GRIS, w: 200 });
                y += 18;
            }
            y += 10;
        }

        // Productos ganadores
        const lista = d.ganadores.items.slice(0, 15);
        titulo('Productos ganadores', `Ordenados por: ${ORDEN[d.ganadores.sort]} · se agota en = stock en Synkro ÷ ventas por día de los últimos ${d.ganadores.paceWindowDays} días`);
        if (!lista.length) {
            texto('No hubo ventas de productos en este periodo.', M, y, { size: 9, color: GRIS });
            y += 20;
        } else {
            const col = { n: M, foto: M + 16, prod: M + 50, uni: M + 250, ing: M + 290, stock: M + 360, dias: M + 400, rec: M + 455 };
            const cabecera = () => {
                doc.rect(M, y, UTIL, 16).fill(SUAVE);
                const h = { size: 7.5, bold: true, color: GRIS };
                texto('#', col.n + 3, y + 4, { ...h, w: 14 });
                texto('Producto', col.prod, y + 4, { ...h, w: 190 });
                texto('Unid.', col.uni, y + 4, { ...h, w: 36, align: 'right' });
                texto('Ingresos', col.ing, y + 4, { ...h, w: 66, align: 'right' });
                texto('Stock', col.stock, y + 4, { ...h, w: 34, align: 'right' });
                texto('Se agota en', col.dias, y + 4, { ...h, w: 52 });
                texto('Recomendación', col.rec, y + 4, { ...h, w: 90 });
                y += 20;
            };
            asegurar(60);
            cabecera();
            lista.forEach((g, i) => {
                if (y + 34 > ALTO - M - PIE) { doc.addPage(); y = M; cabecera(); }
                const foto = g.imageUrl ? fotos.get(g.imageUrl) : undefined;
                texto(i + 1, col.n + 3, y + 11, { size: 8, color: GRIS, w: 14 });
                if (foto) { try { doc.image(foto.buffer, col.foto, y + 2, { fit: [30, 30], align: 'center', valign: 'center' }); } catch { doc.roundedRect(col.foto, y + 2, 30, 30, 3).fill(SUAVE); } }
                else doc.roundedRect(col.foto, y + 2, 30, 30, 3).fill(SUAVE);
                doc.font('Helvetica-Bold').fontSize(8).fillColor(TINTA).text(seguro(g.name), col.prod, y + 3, { width: 192, height: 20, ellipsis: true });
                texto([g.variant, g.sku].filter(Boolean).join(' · '), col.prod, y + 24, { size: 7, color: GRIS, w: 192 });
                texto(entero(g.units), col.uni, y + 11, { size: 9, bold: true, w: 36, align: 'right' });
                texto(dinero(g.revenue), col.ing, y + 8, { size: 8.5, bold: true, w: 66, align: 'right' });
                texto(`${g.share}%`, col.ing, y + 20, { size: 7, color: GRIS, w: 66, align: 'right' });
                texto(g.stock == null ? '-' : entero(g.stock), col.stock, y + 11, { size: 9, w: 34, align: 'right' });
                const [t, f] = COLOR_DE_STOCK[g.estimate.estado];
                doc.roundedRect(col.dias, y + 7, 52, 15, 4).fill(hex(f));
                texto(diasTexto(g), col.dias, y + 11, { size: 7.5, bold: true, color: hex(t), w: 52, align: 'center' });
                texto(g.estimate.recomendacion, col.rec, y + 8, { size: 7.5, w: 92 });
                if (g.estimate.sugerido > 0) texto(`Reponer ~${entero(g.estimate.sugerido)} u.`, col.rec, y + 19, { size: 7, color: GRIS, w: 92 });
                doc.moveTo(M, y + 33).lineTo(M + UTIL, y + 33).lineWidth(0.4).strokeColor(LINEA).stroke();
                y += 34;
            });
            y += 6;
            asegurar(24);
            texto('El stock es el que tiene Synkro; cada canal puede tener otro número. El ritmo de venta se mide sobre los últimos 30 días (o los días que lleva vendiéndose, si es menos).', M, y, { size: 7, color: GRIS });
        }

        // Pie con número de página
        const paginas = doc.bufferedPageRange();
        for (let p = 0; p < paginas.count; p++) {
            doc.switchToPage(paginas.start + p);
            doc.page.margins.bottom = 0;
            texto(`Synkro AI · ${d.tienda} · generado el ${d.generado.toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}`, M, ALTO - 24, { size: 7, color: GRIS, w: UTIL - 60 });
            texto(`Página ${p + 1} de ${paginas.count}`, ANCHO - M - 60, ALTO - 24, { size: 7, color: GRIS, w: 60, align: 'right' });
        }
        doc.end();
    });
}
