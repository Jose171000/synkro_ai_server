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
