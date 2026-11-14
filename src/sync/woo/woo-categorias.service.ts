import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { ListingLink } from '../entities/listing-link.entity';
import { SyncScope, SyncService } from '../sync.service';
import { EcommerceSyncService } from '../channels/ecommerce-sync.service';
import { WooApiService } from './woo-api.service';
import { CLAVE_CATEGORIAS_WOO, candidatasParaIA, categoriaPorId, CategoriaConRuta, elegirPorTexto, OrigenDeCategoria, rutasDeCategorias } from './woo-categorias';

const MINUTOS_EN_MEMORIA = 10;
/** Hasta esta cantidad de categorías se le manda toda la lista a la IA; con más, solo las más parecidas al producto. */
const MAX_CATEGORIAS_PARA_IA = 150;

export interface CategoriaElegida {
    categoria: CategoriaConRuta;
    origen: OrigenDeCategoria;
    /** Qué dijo la IA, cuando fue ella quien eligió. */
    motivo?: string;
}

/**
 * La categoría de WooCommerce de un producto, elegida SOLA entre las categorías que ya existen en la tienda (nunca se crean):
 *  1) la que ya se eligió antes (a mano o sola) y sigue existiendo;
 *  2) por texto: la categoría escrita en el producto, o la que se llama como lo que es («Sábanas»);
 *  3) con IA (nombre, descripción y foto), solo entre las de la tienda.
 * Un grupo de variantes comparte una sola categoría.
 */
@Injectable()
export class WooCategoriasService {
    private readonly logger = new Logger(WooCategoriasService.name);
    private readonly enMemoria = new Map<string, { hasta: number; lista: CategoriaConRuta[] }>();

    constructor(
        @InjectRepository(Product) private readonly productRepository: Repository<Product>,
        @InjectRepository(ListingLink) private readonly listingLinkRepository: Repository<ListingLink>,
        private readonly api: WooApiService,
        private readonly sync: SyncService,
        private readonly ecommerce: EcommerceSyncService,
    ) { }

    private async auth(connectionId: string) {
        return this.ecommerce.authOf(await this.sync.getValidConnectionById(connectionId));
    }

    /** Las categorías de la tienda con su ruta («Hogar › Cama › Sábanas»). Se guardan unos minutos para no consultar a cada producto. */
    async listar(connectionId: string, refrescar = false): Promise<CategoriaConRuta[]> {
        const guardada = this.enMemoria.get(connectionId);
        if (!refrescar && guardada && guardada.hasta > Date.now()) return guardada.lista;
        const lista = rutasDeCategorias(await this.api.listarCategorias(await this.auth(connectionId)))
            .sort((a, b) => a.ruta.localeCompare(b.ruta, 'es'));
        this.enMemoria.set(connectionId, { hasta: Date.now() + MINUTOS_EN_MEMORIA * 60_000, lista });
        return lista;
    }

    private guardadaEn(producto: Product, connectionId: string): { id: number; origen?: string } | null {
        const g = ((producto.aiAttributes as any)?.[CLAVE_CATEGORIAS_WOO] ?? {})[connectionId];
        return g?.id ? g : null;
    }

    private async guardar(familia: Product[], connectionId: string, elegida: CategoriaElegida): Promise<void> {
        for (const p of familia) {
            const atributos: Record<string, any> = { ...((p.aiAttributes as any) || {}) };
            atributos[CLAVE_CATEGORIAS_WOO] = { ...(atributos[CLAVE_CATEGORIAS_WOO] ?? {}), [connectionId]: { id: elegida.categoria.id, ruta: elegida.categoria.ruta, origen: elegida.origen } };
            p.aiAttributes = atributos as any;
            await this.productRepository.update(p.id, { aiAttributes: atributos } as any);
        }
    }

    /** Elige (y guarda) la categoría del producto o de su grupo. Devuelve null si ninguna de la tienda encaja. */
    async elegir(familia: Product[], connectionId: string, opciones: { ignorarGuardada?: boolean } = {}): Promise<CategoriaElegida | null> {
        const lista = await this.listar(connectionId);
        if (!lista.length || !familia.length) return null;
        const primero = familia[0];

        if (!opciones.ignorarGuardada) {
            const g = this.guardadaEn(primero, connectionId);
            const vigente = g ? categoriaPorId(g.id, lista) : null;
            if (vigente) return { categoria: vigente, origen: g!.origen === 'manual' ? 'manual' : 'guardada' };
        }

        const grupo = primero.group?.name;
        const titulo = [grupo, primero.aiTitle, primero.name].filter(Boolean).join(' ');
        const porTexto = elegirPorTexto({ categoria: primero.category, subcategoria: primero.subCategory, titulo }, lista);
        let elegida: CategoriaElegida | null = porTexto ? { categoria: porTexto, origen: 'texto' } : null;

        if (!elegida && this.sync.categoriaWooConIA) {
            const foto = familia.flatMap((p) => p.images ?? []).map((i) => i?.url).find((u) => /^https?:\/\//i.test(u ?? ''));
            const r = await this.sync.categoriaWooConIA({
                producto: grupo || primero.aiTitle || primero.name,
                descripcion: primero.aiDescription || primero.description,
                imagen: foto ?? null,
                categorias: candidatasParaIA({ titulo, descripcion: primero.aiDescription || primero.description }, lista, MAX_CATEGORIAS_PARA_IA).map((c) => ({ id: c.id, ruta: c.ruta })),
            });
            const c = r.id ? categoriaPorId(r.id, lista) : null;
            if (c) elegida = { categoria: c, origen: 'ia', motivo: r.motivo };
        }

        if (elegida) await this.guardar(familia, connectionId, elegida);
        else this.logger.warn(`Ninguna categoría de la tienda encaja con «${titulo}»: queda en la categoría por defecto de WordPress.`);
        return elegida;
    }

    /**
     * Categoría de un producto (o de su grupo): fija la que se indica, vuelve a elegir sola (`reelegir`) o, sin ninguna de las dos, devuelve la
     * ya elegida (eligiéndola sola si todavía no hay).
     * Si el producto ya está en WooCommerce, también se cambia allí (solo la categoría: nada más se toca).
     */
    async fijar(scope: SyncScope, productId: string, connectionId: string | undefined, categoryId?: number, reelegir = false) {
        const conexion = await this.sync.resolveConnection(scope.storeId, 'woocommerce', connectionId);
        const familia = await this.sync.familiaDe(scope, productId);
        const lista = await this.listar(conexion.id, true);

        let elegida: CategoriaElegida | null;
        if (categoryId) {
            const c = categoriaPorId(categoryId, lista);
            if (!c) throw new BadRequestException('Esa categoría no existe en la tienda WooCommerce.');
            elegida = { categoria: c, origen: 'manual' };
            await this.guardar(familia, conexion.id, elegida);
        } else {
            elegida = await this.elegir(familia, conexion.id, { ignorarGuardada: reelegir });
            if (!elegida) throw new BadRequestException('Ninguna categoría de la tienda encaja con este producto: elígela a mano.');
        }

        // Solo cuando la categoría cambia (a mano o al volver a elegir) se toca WooCommerce; consultar la elegida no escribe nada.
        const cambia = !!categoryId || reelegir;
        const enlaces = !cambia ? [] : await this.listingLinkRepository.find({
            where: { marketplace: 'woocommerce', connection: { id: conexion.id }, product: { id: In(familia.map((p) => p.id)) } },
        });
        const idsEnWoo = [...new Set(enlaces.map((e) => e.externalId).filter(Boolean))];
        if (idsEnWoo.length) {
            const auth = await this.auth(conexion.id);
            for (const id of idsEnWoo) await this.api.actualizarProducto(auth, id, { categories: [{ id: elegida.categoria.id }] });
        }
        return { categoria: elegida.categoria, origen: elegida.origen, motivo: elegida.motivo ?? null, actualizadosEnWoo: idsEnWoo.length };
    }
}
