/**
 * Envío de stock y precio a Ripley (Mirakl OF24), parte pura.
 *
 * OF24 (POST /api/offers) REEMPLAZA la oferta entera: lo que no se manda vuelve a su valor por defecto (stock 0, descuento borrado,
 * plazos borrados…) y no existe modo parcial. Por eso nunca se arma una oferta desde cero: se lee la actual (OF21), se cambia solo
 * el stock y/o el precio y se manda COMPLETA. Los nombres de lectura y de escritura de Mirakl no coinciden; aquí se traducen.
 */

/** El descuento que se quiere en una oferta: precio rebajado y fechas (AAAA-MM-DD, opcionales). `precio: null` lo quita. */
export interface DescuentoPedido {
    precio: number | null;
    desde?: string | null;
    hasta?: string | null;
}

export interface CambiosDeOferta {
    /** Stock nuevo. Si no se indica, se conserva el que tiene Ripley. */
    stock?: number | null;
    /** Precio nuevo. Si no se indica, se conserva el que tiene Ripley. */
    price?: number | null;
    /** Descuento nuevo (o quitarlo con precio null). Sin indicar, se conserva el que tiene Ripley. No va junto con un cambio de precio. */
    descuento?: DescuentoPedido | null;
}

const hay = (v: unknown) => v !== undefined && v !== null && v !== '';

/**
 * Las fechas se escriben AAAA-MM-DD. Mirakl las guarda como instante; las de Ripley Perú vienen a medianoche de Lima («…T05:00:00Z»),
 * y así se mandan. Una fecha ya completa (con hora) se respeta.
 */
export function fechaParaMirakl(fecha: unknown): string | undefined {
    if (!hay(fecha)) return undefined;
    const t = String(fecha).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return `${t}T05:00:00Z`;
    if (/^\d{4}-\d{2}-\d{2}T/.test(t) && !Number.isNaN(Date.parse(t))) return t;
    throw new Error(`Fecha no válida para Ripley: «${t}» (usa AAAA-MM-DD).`);
}

/** Cómo viaja un descuento pedido en una solicitud de Revisión (el valor se guarda como texto). «quitar» lo borra. */
export const valorDeDescuento = (d: DescuentoPedido): string => (d.precio === null ? 'quitar' : `${d.precio}|${d.desde ?? ''}|${d.hasta ?? ''}`);

export function descuentoDeValor(valor: unknown): DescuentoPedido | null {
    const t = String(valor ?? '').trim();
    if (t === 'quitar') return { precio: null };
    const [precio, desde, hasta] = t.split('|');
    const p = Number(precio);
    if (!precio || !Number.isFinite(p) || p <= 0) return null;
    return { precio: p, desde: desde || null, hasta: hasta || null };
}

/** Quita los campos vacíos: Mirakl trata «no mandado» como «borrar», pero un null explícito puede rechazarse. */
function sinVacios<T extends Record<string, any>>(o: T): Partial<T> {
    const salida: Record<string, any> = {};
    for (const [k, v] of Object.entries(o)) if (hay(v)) salida[k] = v;
    return salida as Partial<T>;
}

/**
 * Mirakl siempre devuelve un tramo «desde 1 unidad» que repite el precio normal. Eso no es un precio por volumen: se regenera solo
 * a partir del precio y del descuento. Un tramo real es el que empieza en más de 1 unidad o el que hay más de uno.
 */
const esSoloElTramoNormal = (tramos: any): boolean =>
    !Array.isArray(tramos) || tramos.length === 0 || (tramos.length === 1 && Number(tramos[0]?.quantity_threshold) === 1);

/** Una oferta con precios por canal o por volumen reales no se toca: no hay forma segura de reescribirla completa. */
export function motivoParaNoTocarOferta(actual: any): string | null {
    const precios: any[] = Array.isArray(actual?.all_prices) ? actual.all_prices : [];
    if (precios.some((p) => hay(p?.channel_code))) return 'La oferta tiene precios por canal en Ripley; Synkro no la modifica para no borrarlos.';
    if (precios.some((p) => !esSoloElTramoNormal(p?.volume_prices))) return 'La oferta tiene precios por volumen en Ripley; Synkro no la modifica para no borrarlos.';
    if (!esSoloElTramoNormal(actual?.discount?.ranges)) return 'La oferta tiene descuentos por cantidad en Ripley; Synkro no la modifica para no borrarlos.';
    if (!hay(actual?.state_code)) return 'Ripley no dijo el estado (state_code) de la oferta; sin él no se puede reescribir completa.';
    return null;
}

/**
 * La oferta tal como hay que mandarla a OF24: todo lo que ya tenía en Ripley, con el stock y/o el precio nuevos.
 * Lanza si no se puede hacerlo sin perder datos.
 */
export function armarOfertaParaEnviar(actual: any, cambios: CambiosDeOferta): Record<string, any> {
    const motivo = motivoParaNoTocarOferta(actual);
    if (motivo) throw new Error(motivo);
    if (!hay(actual?.shop_sku)) throw new Error('La oferta de Ripley no trae su SKU.');

    const stock = hay(cambios.stock) ? Number(cambios.stock) : Number(actual?.quantity ?? 0);
    if (!Number.isInteger(stock) || stock < 0) throw new Error(`Stock no válido para Ripley: ${cambios.stock}.`);
    const d = actual?.discount;
    const tieneDescuento = hay(d?.discount_price) || hay(d?.price);
    // Con descuento, el precio de lista es el «origin_price» y el rebajado va aparte: mandar el rebajado como precio borraría la rebaja.
    const precioDeLista = Number(d?.origin_price ?? actual?.all_prices?.[0]?.unit_origin_price ?? actual?.price);
    // Regla acordada: una oferta con rebaja en Ripley no se toca en precio (ni lista ni rebaja). Se cambia en Ripley o con una promoción.
    if (hay(cambios.price) && tieneDescuento && Number(cambios.price) !== precioDeLista) {
        throw new Error(`La oferta tiene una rebaja en Ripley (lista ${precioDeLista}, rebaja ${Number(d?.discount_price ?? d?.price)}); Synkro no cambia el precio de las ofertas con rebaja.`);
    }
    const precio = tieneDescuento ? precioDeLista : hay(cambios.price) ? Number(cambios.price) : Number(actual?.price);
    if (!Number.isFinite(precio) || precio <= 0) throw new Error(`Precio no válido para Ripley: ${hay(cambios.price) ? cambios.price : actual?.price}.`);

    let descuento = tieneDescuento
        ? sinVacios({ price: Number(d.discount_price ?? d.price), start_date: d.start_date, end_date: d.end_date })
        : undefined;

    // Un descuento pedido reemplaza al que tiene la oferta; con precio null se quita. El precio de lista no cambia en este flujo.
    if (cambios.descuento !== undefined && cambios.descuento !== null) {
        if (hay(cambios.price)) throw new Error('Un cambio de descuento no puede ir junto con un cambio de precio.');
        const pedido = cambios.descuento;
        if (pedido.precio === null) {
            descuento = undefined;
        } else {
            const p = Number(pedido.precio);
            if (!Number.isFinite(p) || p <= 0 || p >= precio) throw new Error(`El descuento (${pedido.precio}) debe ser mayor que 0 y menor que el precio de lista (${precio}).`);
            const desde = fechaParaMirakl(pedido.desde);
            const hasta = fechaParaMirakl(pedido.hasta);
            if (desde && hasta && Date.parse(hasta) < Date.parse(desde)) throw new Error('La fecha final del descuento no puede ser anterior a la inicial.');
            descuento = sinVacios({ price: p, start_date: desde, end_date: hasta });
        }
    }

    const adicionales: any[] = Array.isArray(actual?.offer_additional_fields)
        ? actual.offer_additional_fields.filter((c: any) => hay(c?.code) && hay(c?.value)).map((c: any) => sinVacios({ code: c.code, type: c.type, value: c.value }))
        : [];
    const eco: any[] = Array.isArray(actual?.eco_contributions) ? actual.eco_contributions : [];

    return sinVacios({
        shop_sku: String(actual.shop_sku),
        update_delete: 'update',
        state_code: String(actual.state_code),
        price: precio,
        quantity: stock,
        description: actual.description,
        internal_description: actual.internal_description,
        price_additional_info: actual.price_additional_info,
        leadtime_to_ship: actual.leadtime_to_ship,
        min_quantity_alert: actual.min_quantity_alert,
        min_order_quantity: actual.min_order_quantity,
        max_order_quantity: actual.max_order_quantity,
        package_quantity: actual.package_quantity,
        // En lectura es un objeto {code,label}; en escritura, el código.
        logistic_class: typeof actual.logistic_class === 'object' ? actual.logistic_class?.code : actual.logistic_class,
        product_tax_code: actual.product_tax_code,
        allow_quote_requests: typeof actual.allow_quote_requests === 'boolean' ? actual.allow_quote_requests : undefined,
        // Las fechas de disponibilidad se leen como available_start_date/end_date y se escriben como available_started/ended.
        available_started: actual.available_start_date,
        available_ended: actual.available_end_date,
        discount: descuento && Object.keys(descuento).length ? descuento : undefined,
        offer_additional_fields: adicionales.length ? adicionales : undefined,
        eco_contributions: eco.length ? eco : undefined,
    });
}

/** Qué cambiaría entre la oferta actual y la que se enviaría (solo precio y stock; el resto debe quedar igual). */
export function resumenDeCambios(actual: any, enviar: Record<string, any>) {
    return {
        stock: { antes: actual?.quantity ?? null, despues: enviar.quantity },
        // Con descuento, el precio de lista de hoy es el origin_price (el «price» que lee Ripley ya es el rebajado).
        precio: { antes: actual?.discount?.origin_price ?? actual?.price ?? null, despues: enviar.price },
        descuento: { antes: actual?.discount?.discount_price ?? null, despues: enviar.discount?.price ?? null },
    };
}

/**
 * Qué SKU pueden enviarse a Ripley. RIPLEY_PUSH_SKUS = lista separada por comas (el piloto) o «*» (todos).
 * Sin lista no se envía ninguno: encender RIPLEY_PUSH_ENABLED solo nunca basta.
 */
export function skuPermitidoParaRipley(sku: string, lista: string | undefined = process.env.RIPLEY_PUSH_SKUS): boolean {
    const texto = (lista ?? '').trim();
    if (!texto) return false;
    if (texto === '*') return true;
    return texto.split(',').map((s) => s.trim()).filter(Boolean).includes(sku);
}

/** El precio solo se manda si RIPLEY_PUSH_PRICE=true: el piloto empieza solo con stock. */
export const ripleyEnviaPrecio = () => process.env.RIPLEY_PUSH_PRICE === 'true';
