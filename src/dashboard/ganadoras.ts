/**
 * Productos ganadores: lo vendido por SKU y canal en un periodo, resumido para ordenarlo por ingresos o por unidades.
 */

export interface FilaDeVenta {
    sku: string;
    title: string;
    marketplace: string;
    unidades: number;
    importe: number;
}

export interface CanalDeVenta {
    marketplace: string;
    unidades: number;
    importe: number;
    /** Qué parte de lo que ingresó el producto viene de este canal (0 a 100); por unidades si no hay importes. */
    porcentaje: number;
}

export interface VentaDeProducto {
    sku: string;
    title: string;
    unidades: number;
    importe: number;
    /** El canal donde más ingresó este producto. */
    canal: CanalDeVenta | null;
    /** Todos los canales donde se vendió, del que más ingresó al que menos. */
    canales: CanalDeVenta[];
}

const redondear = (n: number) => Math.round(n * 100) / 100;

/**
 * Junta las filas por SKU. Devuelve los `tope` que más ingresaron MÁS los `tope` que más unidades vendieron (sin repetir),
 * ordenados por ingresos: así la pantalla puede mostrar los mejores por cualquiera de los dos criterios sin pedir de nuevo.
 */
export function agruparVentas(filas: FilaDeVenta[], tope = 10): VentaDeProducto[] {
    const porSku = new Map<string, { title: string; canales: Map<string, { unidades: number; importe: number }> }>();
    for (const f of filas) {
        const sku = String(f.sku ?? '').trim();
        if (!sku) continue;
        const producto = porSku.get(sku) ?? { title: f.title, canales: new Map() };
        if (!producto.title && f.title) producto.title = f.title;
        const canal = producto.canales.get(f.marketplace) ?? { unidades: 0, importe: 0 };
        canal.unidades += Number(f.unidades) || 0;
        canal.importe += Number(f.importe) || 0;
        producto.canales.set(f.marketplace, canal);
        porSku.set(sku, producto);
    }

    const todos: VentaDeProducto[] = [...porSku.entries()].map(([sku, p]) => {
        const unidades = [...p.canales.values()].reduce((n, c) => n + c.unidades, 0);
        const importe = [...p.canales.values()].reduce((n, c) => n + c.importe, 0);
        const canales: CanalDeVenta[] = [...p.canales.entries()]
            .map(([marketplace, c]) => ({
                marketplace,
                unidades: c.unidades,
                importe: redondear(c.importe),
                porcentaje: Math.round((importe > 0 ? c.importe / importe : unidades > 0 ? c.unidades / unidades : 0) * 100),
            }))
            .sort((a, b) => b.importe - a.importe || b.unidades - a.unidades);
        return { sku, title: p.title, unidades, importe: redondear(importe), canal: canales[0] ?? null, canales };
    });

    const porImporte = [...todos].sort((a, b) => b.importe - a.importe || b.unidades - a.unidades).slice(0, tope);
    const porUnidades = [...todos].sort((a, b) => b.unidades - a.unidades || b.importe - a.importe).slice(0, tope);
    const elegidos = new Map<string, VentaDeProducto>();
    for (const v of [...porImporte, ...porUnidades]) elegidos.set(v.sku, v);
    return [...elegidos.values()].sort((a, b) => b.importe - a.importe || b.unidades - a.unidades);
}

export interface EnlaceDePublicacion {
    productId: string;
    marketplace: string;
    permalink: string | null;
    syncStatus: string;
}

/**
 * La dirección de la publicación de un producto en un canal. Si hay varias cuentas, se prefiere la publicada; solo se
 * devuelven direcciones web (https) para que el botón nunca lleve a otra cosa.
 */
export function direccionDePublicacion(enlaces: EnlaceDePublicacion[], productId: string, marketplace: string): string | null {
    const candidatos = enlaces.filter((e) => e.productId === productId && e.marketplace === marketplace && /^https:\/\//i.test(String(e.permalink ?? '')));
    const elegido = candidatos.find((e) => e.syncStatus === 'published') ?? candidatos[0];
    return elegido ? String(elegido.permalink) : null;
}
