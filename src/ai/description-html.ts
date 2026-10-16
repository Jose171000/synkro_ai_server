/**
 * Descripción HTML estándar de la agencia, para los canales que aceptan HTML (Falabella, Shopify, WooCommerce…).
 *
 * La IA solo redacta los textos; la estructura (tablas, estilos, orden) la pone este archivo, así que
 * siempre sale idéntica a la plantilla y nunca depende de que el modelo copie bien el código.
 */

export interface DescripcionContenido {
    /** Título del producto optimizado para SEO. */
    title: string;
    intro1: string;
    intro2: string;
    /** Los 4 beneficios con imagen: subtítulo, texto corto y texto alternativo de la imagen. */
    benefits: { subtitle: string; text: string; alt: string }[];
    /** Hasta 6 «¿Por qué elegir este producto?»: característica y beneficio. */
    why: { feature: string; benefit: string }[];
    /** Hasta 8 datos técnicos: nombre y valor. */
    specs: { label: string; value: string }[];
}

export function escaparHtml(texto: unknown): string {
    return String(texto ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const EXT_IMAGEN = /\.(gif|png|jpe?g|webp)(\?|#|$)/i;
const HOSTS_DE_IMAGEN = /(giphy\.com|tenor\.com|imgur\.com|res\.cloudinary\.com|gifyu\.com|ibb\.co)/i;

/** Enlaces de imágenes o GIFs que el cliente pegó en su descripción (en el orden en que los puso). */
export function extraerUrlsDeImagen(texto: string | null | undefined): string[] {
    const vistos = new Set<string>();
    const salida: string[] = [];
    for (const crudo of (texto ?? '').match(URL_RE) ?? []) {
        const url = crudo.replace(/[.,;:!?]+$/, '');
        if (!(EXT_IMAGEN.test(url) || HOSTS_DE_IMAGEN.test(url)) || vistos.has(url)) continue;
        vistos.add(url);
        salida.push(url);
    }
    return salida;
}

/** La descripción del cliente sin los enlaces, para que no ensucien lo que redacta la IA. */
export function quitarUrls(texto: string | null | undefined): string {
    return (texto ?? '').replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Las 4 imágenes de la plantilla: primero las que el cliente pasó (GIFs de sus videos); si faltan,
 * las fotos del propio producto; si aun así no son 4, se repiten las que haya. Sin ninguna, queda vacío.
 */
export function elegirImagenes(delCliente: string[], delProducto: string[], cantidad = 4): string[] {
    const base = [...new Set([...delCliente, ...delProducto].filter((u) => /^https?:\/\//i.test(u)))];
    if (!base.length) return [];
    return Array.from({ length: cantidad }, (_, i) => base[i % base.length]);
}

/** Normaliza lo que devuelva el modelo: textos limpios y listas con el largo que pide la plantilla. */
export function normalizarContenido(crudo: any, nombre: string): DescripcionContenido | null {
    if (!crudo || typeof crudo !== 'object') return null;
    const t = (v: any) => (typeof v === 'string' ? v.trim() : '');
    const lista = (v: any): any[] => (Array.isArray(v) ? v : []);

    const benefits = lista(crudo.benefits)
        .map((b) => ({ subtitle: t(b?.subtitle), text: t(b?.text), alt: t(b?.alt) }))
        .filter((b) => b.subtitle && b.text)
        .slice(0, 4);
    if (!t(crudo.intro1) && !benefits.length) return null;

    return {
        title: t(crudo.title) || nombre,
        intro1: t(crudo.intro1),
        intro2: t(crudo.intro2),
        benefits: benefits.map((b) => ({ ...b, alt: b.alt || b.subtitle })),
        why: lista(crudo.why).map((w) => ({ feature: t(w?.feature), benefit: t(w?.benefit) })).filter((w) => w.feature && w.benefit).slice(0, 6),
        specs: lista(crudo.specs).map((s) => ({ label: t(s?.label), value: t(s?.value) })).filter((s) => s.label && s.value).slice(0, 8),
    };
}

const CELDA_BENEFICIO = (b: { subtitle: string; text: string; alt: string }, url: string | undefined) => `
      <td width="50%" valign="top" align="center">${url ? `
        <img src="${escaparHtml(url)}" alt="${escaparHtml(b.alt)}" style="max-width: 100%; height: auto; border-radius: 8px; margin-bottom: 15px;">` : ''}
        <h3 style="font-size: 22px; margin: 0 0 15px 0; color: #333;">${escaparHtml(b.subtitle)}</h3>
        <p style="margin: 0; font-size: 15px; text-align: left;">
          ${escaparHtml(b.text)}
        </p>
      </td>`;

const FILA_DOBLE = (a: string, b: string, margen: number) => `
  <table width="100%" border="0" cellpadding="15" cellspacing="0" style="margin-bottom: ${margen}px;">
    <tr>${a}${b}
    </tr>
  </table>`;

const COLUMNA_LISTA = (items: string[], margenItem: number) => `
        <td width="50%" valign="top">
          <ul style="margin: 0; padding-left: 20px; font-size: 15px; color: #555;">
${items.map((i) => `            <li style="margin-bottom: ${margenItem}px;">${i}</li>`).join('\n')}
          </ul>
        </td>`;

/** Genera el HTML de la plantilla de la agencia con los textos y las imágenes dados. */
export function renderDescripcionHtml(c: DescripcionContenido, imagenes: string[]): string {
    const beneficios = c.benefits.map((b, i) => CELDA_BENEFICIO(b, imagenes[i]));
    const filasBeneficios = [
        beneficios.length ? FILA_DOBLE(beneficios[0], beneficios[1] ?? '', 20) : '',
        beneficios.length > 2 ? FILA_DOBLE(beneficios[2], beneficios[3] ?? '', 40) : '',
    ].join('');

    const porQue = c.why.map((w) => `<b>${escaparHtml(w.feature)}:</b> ${escaparHtml(w.benefit)}`);
    const mitadPorQue = Math.ceil(porQue.length / 2);
    const bloquePorQue = porQue.length ? `
  <div style="margin-bottom: 40px;">
    <h3 style="text-align: center; font-size: 26px; margin-bottom: 20px; color: #333;">
      ¿Por qué elegir este producto?
    </h3>

    <table width="100%" border="0" cellpadding="15" cellspacing="0">
      <tr>${COLUMNA_LISTA(porQue.slice(0, mitadPorQue), 15)}${porQue.length > mitadPorQue ? COLUMNA_LISTA(porQue.slice(mitadPorQue), 15) : ''}
      </tr>
    </table>
  </div>` : '';

    const datos = c.specs.map((s) => `<b>${escaparHtml(s.label)}:</b> ${escaparHtml(s.value)}`);
    const mitadDatos = Math.ceil(datos.length / 2);
    const bloqueEspecificaciones = datos.length ? `
  <div>
    <h3 style="text-align: center; font-size: 24px; margin-bottom: 20px; color: #333;">Especificaciones Técnicas</h3>

    <table width="100%" border="0" cellpadding="15" cellspacing="0" style="background-color: #f9f9f9; border-radius: 8px;">
      <tr>${COLUMNA_LISTA(datos.slice(0, mitadDatos), 12)}${datos.length > mitadDatos ? COLUMNA_LISTA(datos.slice(mitadDatos), 12) : ''}
      </tr>
    </table>
  </div>` : '';

    return `<div style="max-width: 1000px; margin: 0 auto; font-family: Arial, sans-serif; line-height: 1.5; color: #444; box-sizing: border-box;">

  <div style="text-align: center; margin-bottom: 40px;">
    <h2 style="font-size: 26px; margin: 0 0 15px 0; color: #d32f2f;">${escaparHtml(c.title)}</h2>
    <p style="font-size: 16px; margin: 0 auto 10px; max-width: 800px; padding: 0 10px;">
      ${escaparHtml(c.intro1)}
    </p>${c.intro2 ? `
    <p style="font-size: 16px; margin: 0 auto; max-width: 800px; padding: 0 10px;">
      ${escaparHtml(c.intro2)}
    </p>` : ''}
  </div>
${filasBeneficios}
${bloquePorQue}
${bloqueEspecificaciones}

</div>`;
}
