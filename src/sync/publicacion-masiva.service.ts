import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { categoriasElegidas } from '../ai/categorias-elegidas';
import { ListingLink } from './entities/listing-link.entity';
import { MarketplaceConnection } from './entities/marketplace-connection.entity';
import { SyncScope, SyncService } from './sync.service';
import { CANALES_DE_PUBLICACION_MASIVA, EnlaceDeCanal, MiembroParaPublicar, evaluarFamilia, motivoRipleyNoDisponible } from './publicacion-masiva';

/** Cuántos productos (un grupo de variantes cuenta como uno) caben en una tanda. */
export const MAX_PUBLICACION_MASIVA = 25;

const NOMBRES: Record<string, string> = { mercadolibre: 'Mercado Libre', falabella: 'Falabella', woocommerce: 'WooCommerce', ripley: 'Ripley', yavendio: 'Yavendió', shopify: 'Shopify' };

export interface FilaDeVista {
    clave: string;
    productId: string;
    etiqueta: string;
    variantes: number;
    cuentas: Record<string, { estado: 'nada' | 'listo' | 'incompleto'; publicadas: number; enProceso: number; porPublicar: number; incompletas: { sku: string; motivos: string[] }[] }>;
}

/**
 * Publica de una vez, en las cuentas de canal que la persona elija, los productos seleccionados que aún no están en ellas.
 * No hace nada nuevo con los canales: cada envío es el mismo «Publicar» de siempre (con su cola y sus límites de ritmo).
 */
@Injectable()
export class PublicacionMasivaService {
    constructor(
        private readonly sync: SyncService,
        @InjectRepository(Product) private readonly productos: Repository<Product>,
        @InjectRepository(MarketplaceConnection) private readonly conexiones: Repository<MarketplaceConnection>,
        @InjectRepository(ListingLink) private readonly enlaces: Repository<ListingLink>,
    ) {}

    /** Lo que se vería al publicar: por cada cuenta conectada, cuántos productos le faltan y cuáles no están listos y por qué. */
    async vista(scope: SyncScope, productIds: string[]) {
        const ids = [...new Set((productIds ?? []).filter(Boolean))];
        if (!ids.length) throw new BadRequestException('Selecciona al menos un producto.');

        const elegidos = await this.productos.find({ where: { id: In(ids), store: { id: scope.storeId } } as any, relations: { group: true }, order: { createdAt: 'ASC' } });
        if (!elegidos.length) throw new BadRequestException('No se encontró ninguno de los productos seleccionados en esta tienda.');

        // Un grupo cuenta como un producto y se evalúa con TODAS sus variantes.
        const gruposIds = [...new Set(elegidos.map((p) => p.group?.id).filter(Boolean) as string[])];
        const deGrupo = gruposIds.length
            ? await this.productos.find({ where: { group: { id: In(gruposIds) } } as any, relations: { group: true, images: true }, order: { createdAt: 'ASC' } })
            : [];
        const sueltos = elegidos.filter((p) => !p.group?.id);
        const sueltosConFotos = sueltos.length ? await this.productos.find({ where: { id: In(sueltos.map((p) => p.id)) }, relations: { images: true } }) : [];

        const familias = new Map<string, { productId: string; etiqueta: string; miembros: Product[] }>();
        for (const p of deGrupo) {
            const k = `g:${p.group!.id}`;
            const f = familias.get(k) ?? { productId: p.id, etiqueta: (p.group!.name || p.aiTitle || p.name || p.sku).slice(0, 120), miembros: [] };
            f.miembros.push(p);
            familias.set(k, f);
        }
        for (const p of sueltosConFotos) familias.set(`p:${p.id}`, { productId: p.id, etiqueta: (p.aiTitle || p.name || p.sku).slice(0, 120), miembros: [p] });
        if (familias.size > MAX_PUBLICACION_MASIVA) {
            throw new BadRequestException(`Seleccionaste ${familias.size} productos (los grupos de variantes cuentan como uno). El máximo por tanda es ${MAX_PUBLICACION_MASIVA}: divídelo en varias tandas.`);
        }

        const cuentas = await this.conexiones.find({ where: { store: { id: scope.storeId }, status: 'active' } as any, order: { createdAt: 'ASC' } });
        const publicables = cuentas.filter((c) => (CANALES_DE_PUBLICACION_MASIVA as readonly string[]).includes(c.marketplace) && !(c.marketplace === 'ripley' && motivoRipleyNoDisponible()));
        const todosLosIds = [...familias.values()].flatMap((f) => f.miembros.map((m) => m.id));
        const enlaces = publicables.length
            ? await this.enlaces.find({ where: { product: { id: In(todosLosIds) }, connection: { id: In(publicables.map((c) => c.id)) } } as any, relations: { product: true, connection: true } })
            : [];
        const porCuenta = new Map<string, Map<string, EnlaceDeCanal>>();
        for (const e of enlaces) {
            if (!e.connection || !e.product) continue;
            const m = porCuenta.get(e.connection.id) ?? new Map<string, EnlaceDeCanal>();
            m.set(e.product.id, { syncStatus: e.syncStatus, updatedAt: e.updatedAt });
            porCuenta.set(e.connection.id, m);
        }

        const filas: FilaDeVista[] = [];
        for (const [clave, f] of familias) {
            const miembros: MiembroParaPublicar[] = f.miembros.map((m) => ({
                id: m.id, sku: m.sku, price: m.price as any, fotos: (m.images ?? []).length,
                categorias: categoriasElegidas(m.marketplaceIds as any, m.aiAttributes as any),
                ripleyEnviado: !!(m.aiAttributes as any)?.ripley_envio,
            }));
            const fila: FilaDeVista = { clave, productId: f.productId, etiqueta: f.etiqueta, variantes: f.miembros.length, cuentas: {} };
            for (const c of publicables) {
                const r = evaluarFamilia(c.marketplace, miembros, porCuenta.get(c.id) ?? new Map());
                fila.cuentas[c.id] = { estado: r.estado, publicadas: r.publicadas, enProceso: r.enProceso, porPublicar: r.porPublicar, incompletas: r.incompletas };
            }
            filas.push(fila);
        }

        return {
            cuentas: cuentas.map((c) => {
                const motivoRipley = c.marketplace === 'ripley' ? motivoRipleyNoDisponible() : null;
                const soportada = (CANALES_DE_PUBLICACION_MASIVA as readonly string[]).includes(c.marketplace) && !motivoRipley;
                return {
                    id: c.id, marketplace: c.marketplace, canal: NOMBRES[c.marketplace] ?? c.marketplace, cuenta: c.label ?? '',
                    soportada,
                    motivoNoDisponible: soportada ? null : motivoRipley ?? 'Este canal todavía no se publica de forma masiva.',
                    faltan: soportada ? filas.filter((f) => f.cuentas[c.id]?.estado !== 'nada').length : 0,
                    listos: soportada ? filas.filter((f) => f.cuentas[c.id]?.estado === 'listo').length : 0,
                };
            }),
            productos: filas,
            total: filas.length,
            maximo: MAX_PUBLICACION_MASIVA,
        };
    }

    /** Encola la publicación de lo que está listo en las cuentas elegidas. Lo que no está listo se salta con su motivo; nada frena a lo demás. */
    async publicar(scope: SyncScope, productIds: string[], connectionIds: string[]) {
        const elegidas = [...new Set((connectionIds ?? []).filter(Boolean))];
        if (!elegidas.length) throw new BadRequestException('Elige al menos una cuenta donde publicar.');
        const v = await this.vista(scope, productIds);
        const cuentas = v.cuentas.filter((c) => elegidas.includes(c.id));
        if (cuentas.length !== elegidas.length) throw new BadRequestException('Alguna de las cuentas elegidas no está conectada en esta tienda.');
        const noSoportada = cuentas.find((c) => !c.soportada);
        if (noSoportada) throw new BadRequestException(`${noSoportada.canal}: ${noSoportada.motivoNoDisponible}`);

        const encoladas: { producto: string; cuenta: string; variantes: number }[] = [];
        const omitidas: { producto: string; cuenta: string; motivo: string }[] = [];
        for (const fila of v.productos) {
            for (const c of cuentas) {
                const r = fila.cuentas[c.id];
                const nombreCuenta = `${c.canal}${c.cuenta ? ` · ${c.cuenta}` : ''}`;
                if (!r || r.estado === 'nada') { omitidas.push({ producto: fila.etiqueta, cuenta: nombreCuenta, motivo: r?.enProceso ? 'Ya se está publicando.' : 'Ya está publicado.' }); continue; }
                if (r.estado === 'incompleto') {
                    const razon = r.incompletas.slice(0, 2).map((i) => `${i.sku}: ${i.motivos.join(', ')}`).join(' — ');
                    omitidas.push({ producto: fila.etiqueta, cuenta: nombreCuenta, motivo: `No está listo (${razon}${r.incompletas.length > 2 ? '…' : ''}).` });
                    continue;
                }
                try {
                    await this.sync.enqueuePublishFamilia(scope, fila.productId, [c.marketplace], { [c.marketplace]: c.id });
                    encoladas.push({ producto: fila.etiqueta, cuenta: nombreCuenta, variantes: r.porPublicar });
                } catch (error: any) {
                    omitidas.push({ producto: fila.etiqueta, cuenta: nombreCuenta, motivo: String(error?.response?.message ?? error?.message ?? 'No se pudo encolar.').slice(0, 200) });
                }
            }
        }
        return { encoladas, omitidas, message: encoladas.length ? `Publicación encolada: ${encoladas.length} envío(s). Mira el avance en el estado de cada publicación.` : 'No se encoló ningún envío.' };
    }
}
