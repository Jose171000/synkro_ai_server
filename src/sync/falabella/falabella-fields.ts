/**
 * Campos que Falabella lista entre los atributos de una categoría pero que NO son datos del producto que
 * se completen a mano o con IA: los pone la plataforma por su cuenta, o son del sistema (identificadores,
 * impuestos, tipo de envío, variantes). Enviarlos puede hacer que Falabella rechace la ficha con
 * «… is/are not applicable to <categoría>».
 */
export const ATRIBUTOS_DE_SISTEMA = new Set([
    // Los cubre la plataforma al publicar
    'name', 'brand', 'description', 'primary_category', 'seller_sku',
    'condition_type', 'package_width', 'package_length', 'package_height',
    'package_weight', 'variation', 'price', 'stock', 'status',
    // De sistema: no aplican a todas las categorías y no son datos del producto
    'parent_sku', 'tax_class', 'shipment_type', 'product_id', 'shop_sku',
    'sale_price', 'sale_start_date', 'sale_end_date', 'quantity', 'product_group', 'operator_code',
]);

/** Nombre normalizado de un atributo, para compararlo sin importar mayúsculas, guiones o guiones bajos. */
export const claveDeAtributo = (nombre: string) => String(nombre ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Atributos que Falabella respondió que «no aplican» a la categoría de este producto. Se guardan en el
 * propio producto para no volver a enviarlos en el siguiente intento.
 */
export function atributosQueNoAplican(aiAttributes: Record<string, any> | null | undefined): Set<string> {
    const lista = (aiAttributes as any)?._noAplica;
    return new Set(Array.isArray(lista) ? lista.map(claveDeAtributo) : []);
}

/** De «0: ParentSku, TaxClass, ShipmentType is/are not applicable to Bebés» → ['ParentSku','TaxClass','ShipmentType']. */
export function leerAtributosNoAplicables(mensaje: string | null | undefined): string[] {
    const m = String(mensaje ?? '').match(/(?:\d+:\s*)?(.+?)\s+is\/are not applicable/i);
    if (!m) return [];
    return m[1].split(',').map((t) => t.trim()).filter(Boolean);
}
