import { Product } from '../../products/entities/product.entity';
import { nombreDeFamilia } from '../../products/titulos-de-variante';

/**
 * El «Modelo» que se manda a Mercado Libre: el que esté escrito (por la persona, el canal o la IA) y, si no hay, el nombre del
 * producto (el del grupo en una familia, para que sea el mismo en todas sus variantes). Nunca el SKU ni el código del grupo.
 */
export function modeloParaMeli(product: Product, delCanal: Record<string, unknown>): string {
    const attrs: Record<string, any> = (product.aiAttributes as any) || {};
    const grupo = (product as any).group;
    const internos = [product.sku, grupo?.parentSku].map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean);
    const sirve = (v: unknown) => typeof v === 'string' && !!v.trim() && !internos.includes(v.trim().toLowerCase());
    const escrito = [delCanal.MODEL, attrs.Modelo, attrs.modelo, attrs.model].find(sirve) as string | undefined;
    const familia = sirve(grupo?.name) ? nombreDeFamilia(grupo.name, (grupo.axes ?? []).flatMap((e: any) => e.values), 60) : undefined;
    const nombre = [familia, product.aiTitle, product.name].find(sirve) as string | undefined;
    return (escrito ?? nombre ?? 'Genérico').trim().slice(0, 60);
}
