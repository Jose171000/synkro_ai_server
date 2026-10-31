/**
 * El texto de la descripción de un producto en canales sin HTML: el suyo y, si no tiene, el que sale de su ficha HTML
 * (la de Falabella). Solo para mostrar y para publicaciones nuevas: una publicación que ya existe en el canal tiene su
 * propia descripción y no se reemplaza con esta.
 */
export function descripcionDeTexto(producto: { aiDescription?: string | null; description?: string | null; aiAttributes?: any }): string {
    return descripcionEnTextoPlano(producto.aiDescription || sinEnlaces(producto.description) || producto.aiAttributes?.descriptionHtml);
}

/**
 * El texto de la descripción que se manda a una publicación de Mercado Libre que ya existe: la del producto o, si no tiene,
 * lo que escribió el cliente sin enlaces. No cae a la ficha HTML: la descripción que tenga la publicación no se reemplaza
 * con un texto derivado.
 */
export function descripcionParaActualizar(producto: { aiDescription?: string | null; description?: string | null }): string {
    return descripcionEnTextoPlano(producto.aiDescription || sinEnlaces(producto.description));
}

/**
 * Lo que el cliente escribe en «descripción» sirve para alimentar a la IA y trae enlaces (GIFs, imágenes) pensados para la ficha
 * HTML. En texto plano no pintan nada y Mercado Libre no admite enlaces: se quitan, conservando los saltos de línea.
 */
export function sinEnlaces(texto: string | null | undefined): string {
    return String(texto ?? '')
        .replace(/https?:\/\/[^\s<>"')\]]+/gi, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Mercado Libre solo acepta la descripción en texto plano («The description must be in plain text»), pero la que
 * redacta la IA para Falabella es HTML con imágenes y viñetas. Se pasa a texto conservando los saltos de línea y las viñetas.
 */
export function descripcionEnTextoPlano(html: string | null | undefined): string {
    return String(html ?? '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<img[^>]*>/gi, ' ')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table)>|<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 50000);
}
