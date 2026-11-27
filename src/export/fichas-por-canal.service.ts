import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { ListingLink } from '../sync/entities/listing-link.entity';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';
import { SyncService } from '../sync/sync.service';
import { FalabellaApiService } from '../sync/falabella/falabella-api.service';
import { MeliApiService } from '../sync/meli/meli-api.service';
import { RipleyCatalogoService } from '../sync/ripley/ripley-catalogo.service';
import { atributosObligatoriosAprendidos, claveDeAtributo, esAtributoDeSistema } from '../sync/falabella/falabella-fields';
import { CLAVE_CATEGORIAS_WOO } from '../sync/woo/woo-categorias';
import { atributosDeMeli } from '../ai/channel-attributes.service';
import { atributosConVariante } from '../products/titulos-de-variante';
import { estadoDeCanal } from '../products/completitud';
import { escribirLibro, HojaDeLibro } from '../common/excel/excel';

export const CANALES_DE_FICHA = ['falabella', 'mercadolibre', 'ripley', 'woocommerce'] as const;
export type CanalDeFicha = (typeof CANALES_DE_FICHA)[number];

const NOMBRE: Record<CanalDeFicha, string> = { falabella: 'Falabella', mercadolibre: 'Mercado Libre', ripley: 'Ripley', woocommerce: 'WooCommerce' };
const PREFIJO: Record<CanalDeFicha, string> = { falabella: 'Falabella', mercadolibre: 'MeLi', ripley: 'Ripley', woocommerce: 'Woo' };

const SIN_CATEGORIA = 'Sin categoría';
/** Claves de la ficha que no son atributos de categoría (solo importa cuando Falabella no devuelve la lista de campos). */
const NO_SON_ATRIBUTOS = new Set(['descriptionHtml', 'brand', 'falabella_category_id', 'mercadolibre_category_id', 'ripley_category_id']);
const MELI_APARTE = new Set(['BRAND', 'SELLER_SKU']);

const COLUMNAS_COMUNES = ['SKU', 'Nombre', 'Código de grupo', 'Variante', 'Estado en el canal', 'Motivo de error', 'Marca', 'Precio', 'Stock', 'Largo (cm)', 'Ancho (cm)', 'Alto (cm)', 'Peso (kg)'];

interface Campo { clave: string; etiqueta: string; obligatorio: boolean }
interface Definicion { ruta: string; campos: Campo[]; nota?: string }

const texto = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? (Array.isArray(v) ? v.join(', ') : JSON.stringify(v)) : String(v));

/** Nombre de hoja válido para Excel (31 caracteres, sin \ / ? * [ ] :) y sin repetirse. */
export function nombreDeHoja(base: string, usados: Set<string>): string {
    const limpio = base.replace(/[\\/?*[\]:]/g, '-').replace(/^'+|'+$/g, '').trim() || 'Hoja';
    let nombre = limpio.slice(0, 31);
    for (let n = 2; usados.has(nombre.toLowerCase()); n++) nombre = `${limpio.slice(0, 31 - ` (${n})`.length)} (${n})`;
    usados.add(nombre.toLowerCase());
    return nombre;
}

/**
 * El Excel de «fichas por canal»: una hoja por canal y categoría, con los campos propios de esa categoría como columnas
 * (también los vacíos). Los valores son los que Synkro tiene guardados; al canal solo se le pide la lista de campos.
 */
@Injectable()
export class FichasPorCanalService {
    private readonly logger = new Logger(FichasPorCanalService.name);

    constructor(
        private readonly sync: SyncService,
        private readonly falabella: FalabellaApiService,
        private readonly meli: MeliApiService,
        private readonly ripley: RipleyCatalogoService,
        @InjectRepository(MarketplaceConnection) private readonly cuentas: Repository<MarketplaceConnection>,
    ) { }

    async generar(storeId: string, productos: Product[], enlaces: Map<string, ListingLink[]>, canal?: CanalDeFicha): Promise<Buffer> {
        const canales = canal ? [canal] : [...CANALES_DE_FICHA];
        const usados = new Set<string>(['índice']);
        const indice: any[][] = [];
        const hojas: HojaDeLibro[] = [];
        const conFicha = new Set<string>();

        for (const c of canales) {
            const porCategoria = new Map<string, Product[]>();
            for (const p of productos) {
                const categoria = this.categoriaDe(c, p, enlaces.get(p.id) ?? []);
                if (categoria === null) continue;
                conFicha.add(p.id);
                porCategoria.set(categoria, [...(porCategoria.get(categoria) ?? []), p]);
            }
            if (!porCategoria.size) continue;
            const definir = await this.definidor(c, storeId);

            for (const [categoria, lista] of porCategoria) {
                const def = await definir(categoria, lista);
                const valores = lista.map((p) => this.valoresDe(c, p, def));
                // Un dato guardado que la categoría ya no pide (o sin lista de campos) no se pierde: sale en su propia columna.
                const campos = [...def.campos];
                const conocidos = new Set(campos.map((x) => x.clave));
                for (const v of valores) {
                    for (const clave of v.keys()) {
                        if (!conocidos.has(clave)) { conocidos.add(clave); campos.push({ clave, etiqueta: clave, obligatorio: false }); }
                    }
                }

                const repetidas = new Set(campos.map((x) => x.etiqueta).filter((e, i, todas) => todas.indexOf(e) !== i));
                const columnas = [...COLUMNAS_COMUNES, ...campos.map((x) => `${repetidas.has(x.etiqueta) ? `${x.etiqueta} (${x.clave})` : x.etiqueta}${x.obligatorio ? ' *' : ''}`)];
                const nombre = nombreDeHoja(`${PREFIJO[c]} · ${def.ruta.split(/\s*[›>]\s*/).pop()}`, usados);
                hojas.push({
                    nombre,
                    columnas,
                    fijas: 2,
                    filas: lista.map((p, i) => [...this.comunes(c, p, enlaces.get(p.id) ?? []), ...campos.map((x) => valores[i].get(x.clave) ?? '')]),
                });
                const id = categoria === SIN_CATEGORIA || c === 'woocommerce' ? '' : categoria;
                indice.push([nombre, NOMBRE[c], def.ruta, id, lista.length, campos.length, campos.filter((x) => x.obligatorio).length, def.nota ?? '']);
            }
        }

        const sinFicha = productos.length - conFicha.size;
        const resumen: HojaDeLibro = {
            nombre: 'Índice',
            columnas: ['Hoja', 'Canal', 'Categoría', 'ID de categoría', 'Productos', 'Campos', 'Obligatorios', 'Nota'],
            filas: [
                ...indice,
                ...(sinFicha ? [['', '', '', '', sinFicha, '', '', `Productos sin categoría ni publicación en ${canal ? NOMBRE[canal] : 'ningún canal'}: no salen en ninguna hoja.`]] : []),
                ...(indice.length ? [['', '', '', '', '', '', '', 'Los campos con * son obligatorios. Los valores son los guardados en Synkro.']] : []),
            ],
            enlaces: indice.map((fila, i): [number, number, string] => [i, 0, String(fila[0])]),
        };
        return escribirLibro([resumen, ...hojas]);
    }

    /** En qué categoría del canal cae el producto; null si no tiene nada que ver con ese canal. */
    private categoriaDe(canal: CanalDeFicha, p: Product, enlaces: ListingLink[]): string | null {
        const attrs: Record<string, any> = (p.aiAttributes as any) || {};
        const ids: Record<string, any> = (p.marketplaceIds as any) || {};
        const publicado = enlaces.some((e) => e.marketplace === canal);
        if (canal === 'woocommerce') {
            const categoria = Object.values((attrs[CLAVE_CATEGORIAS_WOO] ?? {}) as Record<string, any>).find((x) => x?.ruta);
            return categoria ? String(categoria.ruta) : publicado ? SIN_CATEGORIA : null;
        }
        const id = canal === 'falabella'
            ? this.sync.categoriaFalabella(p)
            : canal === 'mercadolibre'
                ? (ids.mercadolibre_category_id ?? attrs.mercadolibre_category_id)
                : ids.ripley_category_id;
        if (id) return String(id);
        return publicado || (canal === 'ripley' && (attrs.ripley || attrs.ripley_attributes)) ? SIN_CATEGORIA : null;
    }

    /** Cómo conseguir los campos de cada categoría de un canal. Si el canal no responde, la hoja sale con lo guardado y lo dice. */
    private async definidor(canal: CanalDeFicha, storeId: string): Promise<(categoria: string, productos: Product[]) => Promise<Definicion>> {
        const NO_DISPONIBLE = `No se pudo pedir la lista de campos a ${NOMBRE[canal]}: salen solo los que tienen valor.`;
        const sinCategoria: Definicion = { ruta: SIN_CATEGORIA, campos: [] };

        if (canal === 'woocommerce') {
            return async (categoria) => ({ ruta: categoria, campos: [], nota: 'WooCommerce no tiene atributos por categoría.' });
        }

        if (canal === 'falabella') {
            const cuenta = await this.cuentas.findOne({ where: { store: { id: storeId }, marketplace: 'falabella', status: 'active' }, order: { createdAt: 'ASC' } });
            const creds = cuenta?.accessToken ? this.sync.credentialsOf(cuenta) : null;
            const arbol: { id: string; path: string }[] = creds ? await this.falabella.getCategories(creds).catch(() => []) : [];
            const rutas = new Map(arbol.map((c) => [c.id, c.path]));
            let fallosSeguidos = 0;
            return async (categoria, productos) => {
                if (categoria === SIN_CATEGORIA) return sinCategoria;
                const ruta = rutas.get(categoria) ?? `Categoría ${categoria}`;
                if (!creds) return { ruta, campos: [], nota: 'No hay una cuenta de Falabella conectada: salen solo los campos con valor.' };
                // Con el canal caído o limitando llamadas, insistir por cada categoría solo alarga la descarga.
                if (fallosSeguidos >= 3) return { ruta, campos: [], nota: NO_DISPONIBLE };
                try {
                    const definiciones = await this.falabella.getCategoryAttributes(creds, categoria);
                    fallosSeguidos = 0;
                    const aprendidos = new Set(productos.flatMap((p) => [...atributosObligatoriosAprendidos(p.aiAttributes as any)]));
                    return {
                        ruta,
                        campos: definiciones
                            .filter((a) => !esAtributoDeSistema(a))
                            .map((a) => ({ clave: a.name, etiqueta: a.label || a.name, obligatorio: a.isMandatory || aprendidos.has(claveDeAtributo(a.name)) }))
                            .sort((x, y) => Number(y.obligatorio) - Number(x.obligatorio)),
                    };
                } catch (error: any) {
                    fallosSeguidos++;
                    this.logger.warn(`Atributos de Falabella/${categoria} no disponibles: ${error?.message}`);
                    return { ruta, campos: [], nota: NO_DISPONIBLE };
                }
            };
        }

        if (canal === 'mercadolibre') {
            return async (categoria) => {
                if (categoria === SIN_CATEGORIA) return sinCategoria;
                let ruta = `Categoría ${categoria}`;
                try {
                    const c = await this.meli.getCategory(categoria);
                    ruta = c.path_from_root?.map((x) => x.name).join(' › ') || c.name;
                } catch (error: any) {
                    this.logger.warn(`Categoría de Mercado Libre ${categoria} no disponible: ${error?.message}`);
                }
                try {
                    const campos = atributosDeMeli(await this.meli.getCategoryAttributes(categoria), Infinity)
                        .map((a) => ({ clave: a.name, etiqueta: a.description.split(' — ')[0] || a.name, obligatorio: a.isRequired }));
                    return { ruta, campos };
                } catch (error: any) {
                    this.logger.warn(`Atributos de Mercado Libre/${categoria} no disponibles: ${error?.message}`);
                    return { ruta, campos: [], nota: NO_DISPONIBLE };
                }
            };
        }

        return async (categoria) => {
            if (categoria === SIN_CATEGORIA) return sinCategoria;
            try {
                const c = await this.ripley.campos(categoria);
                const campos = c.campos
                    .map((f) => ({ clave: f.name, etiqueta: f.label || f.name, obligatorio: !!f.required }))
                    .sort((x, y) => Number(y.obligatorio) - Number(x.obligatorio));
                return { ruta: c.path, campos };
            } catch (error: any) {
                this.logger.warn(`Campos de Ripley/${categoria} no disponibles: ${error?.message}`);
                return { ruta: `Categoría ${categoria}`, campos: [], nota: 'La categoría no está en el catálogo de Ripley: salen solo los campos con valor.' };
            }
        };
    }

    /** Los valores guardados del producto para ese canal, por clave de campo (solo los que tienen algo). */
    private valoresDe(canal: CanalDeFicha, p: Product, def: Definicion): Map<string, string> {
        const attrs: Record<string, any> = (p.aiAttributes as any) || {};
        let pares: [string, unknown][] = [];
        if (canal === 'falabella') {
            const efectivos = atributosConVariante(attrs, p.variantValues);
            pares = def.campos.length
                ? def.campos.map((c): [string, unknown] => [c.clave, this.sync.buscarAtributo(efectivos, c.clave)])
                : Object.entries(efectivos).filter(([k, v]) => !k.startsWith('_') && !NO_SON_ATRIBUTOS.has(k) && ['string', 'number', 'boolean'].includes(typeof v));
        } else if (canal === 'mercadolibre') {
            pares = this.sync.atributosParaMeli(p).filter((a) => !MELI_APARTE.has(a.id)).map((a): [string, unknown] => [a.id, a.value_name]);
        } else if (canal === 'ripley') {
            pares = Object.entries(atributosConVariante(attrs.ripley_attributes ?? {}, p.variantValues));
        }
        return new Map(pares.map(([k, v]): [string, string] => [k, texto(v)]).filter(([, v]) => v.trim() !== ''));
    }

    private comunes(canal: CanalDeFicha, p: Product, enlaces: ListingLink[]): any[] {
        const attrs: Record<string, any> = (p.aiAttributes as any) || {};
        const delCanal = enlaces.filter((e) => e.marketplace === canal);
        const cuenta = (e: ListingLink) => (delCanal.length > 1 && e.connection?.label ? `${e.connection.label}: ` : '');
        return [
            p.sku,
            (canal === 'ripley' ? attrs.ripley?.name : null) || p.aiTitle || p.name,
            (p as any).group?.parentSku ?? '',
            p.variantValues ? Object.entries(p.variantValues).map(([k, v]) => `${k}: ${v}`).join(', ') : '',
            delCanal.length ? delCanal.map((e) => `${cuenta(e)}${estadoDeCanal(e)}`).join(' | ') : 'Sin publicar',
            delCanal.filter((e) => e.lastError).map((e) => `${cuenta(e)}${e.lastError}`).join(' | '),
            (canal === 'ripley' ? attrs.ripley?.brand : null) || attrs.brand || '',
            p.price === null || p.price === undefined ? '' : Number(p.price),
            p.stock ?? 0,
            p.packageLength ?? '',
            p.packageWidth ?? '',
            p.packageHeight ?? '',
            p.packageWeight ?? '',
        ];
    }
}
