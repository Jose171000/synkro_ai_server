import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { Product } from './entities/product.entity';
import { ProductsService } from './products.service';
import { ProductGroupsService } from './product-groups.service';
import { randomUUID } from 'crypto';

export type EstadoDeRegeneracion = 'en_cola' | 'generando' | 'listo' | 'sin_cambios' | 'error';

export interface ItemDeRegeneracion {
    /** «p:<productId>» (producto suelto) o «g:<grupoId>» (un grupo de variantes se regenera una sola vez) */
    clave: string;
    productId: string;
    grupoId: string | null;
    sku: string;
    etiqueta: string;
    variantes: number;
    estado: EstadoDeRegeneracion;
    mensaje: string | null;
    actualizado: number;
}

export interface LoteDeRegeneracion {
    id: string;
    storeId: string;
    userId: string;
    creado: number;
    items: ItemDeRegeneracion[];
}

export interface Ambito { userId: string; storeId: string }

/** Tope de productos (o grupos) por tanda y cuántas generaciones de IA corren a la vez en todo el servidor. */
export const maxPorTanda = () => { const n = Math.floor(Number(process.env.REGEN_IA_MAX_POR_TANDA)); return n >= 1 ? n : 25; };
export const concurrenciaDeIA = () => { const n = Math.floor(Number(process.env.REGEN_IA_CONCURRENCIA)); return n >= 1 ? n : 3; };

const TTL_SEGUNDOS = 24 * 3600;
/** Pasado este tiempo sin novedades, un producto «en cola» o «generando» se da por interrumpido (el servidor se reinició). */
const INTERRUMPIDO_MS = 15 * 60_000;
const clave = (id: string) => `regen-ia:${id}`;

/** Un semáforo para toda la aplicación: nunca hay más de N generaciones de IA a la vez, aunque haya varias tandas. */
class Semaforo {
    private libres: number;
    private esperando: (() => void)[] = [];
    constructor(private readonly max: () => number) { this.libres = max(); }
    async adquirir(): Promise<void> {
        if (this.libres > 0) { this.libres--; return; }
        await new Promise<void>((r) => this.esperando.push(r));
    }
    liberar(): void {
        const siguiente = this.esperando.shift();
        if (siguiente) siguiente(); else this.libres++;
    }
}

/**
 * Regenera con IA, para varios productos seleccionados, lo mismo que «Regenerar con IA» de un producto, pero SOLO llenando lo vacío:
 * ficha HTML, descripción, título, puntos clave y atributos. Un grupo de variantes se regenera una sola vez para todas. Nada se envía a los canales.
 * El avance (producto por producto) queda en Redis; mientras corre, la tanda vive en memoria de este proceso.
 */
@Injectable()
export class RegeneracionMasivaService {
    private readonly enMemoria = new Map<string, LoteDeRegeneracion>();
    private readonly semaforo = new Semaforo(concurrenciaDeIA);

    constructor(
        @InjectRepository(Product) private readonly productos: Repository<Product>,
        private readonly products: ProductsService,
        private readonly groups: ProductGroupsService,
        @Inject(REDIS_CLIENT) private readonly redis: Redis,
    ) {}

    /** Prepara la tanda y la deja corriendo en segundo plano. Devuelve enseguida con todos «en cola». */
    async iniciar(ambito: Ambito, productIds: string[], opciones: { tone?: string; marketplaces?: string[]; sobrescribir?: boolean } = {}): Promise<LoteDeRegeneracion> {
        const ids = [...new Set((productIds ?? []).filter(Boolean))];
        if (!ids.length) throw new BadRequestException('Selecciona al menos un producto.');

        const enCurso = await this.loteActivo(ambito.storeId);
        if (enCurso) throw new BadRequestException('Ya hay una regeneración con IA en curso en esta tienda. Espera a que termine para lanzar otra.');

        const encontrados = await this.productos.find({ where: { id: In(ids), store: { id: ambito.storeId } } as any, relations: { group: true }, order: { createdAt: 'ASC' } });
        if (!encontrados.length) throw new NotFoundException('No se encontró ninguno de los productos seleccionados en esta tienda.');

        const items = new Map<string, ItemDeRegeneracion>();
        const ahora = Date.now();
        for (const p of encontrados) {
            const k = p.group?.id ? `g:${p.group.id}` : `p:${p.id}`;
            const previo = items.get(k);
            if (previo) { previo.variantes++; continue; }
            items.set(k, {
                clave: k,
                productId: p.id,
                grupoId: p.group?.id ?? null,
                sku: p.group?.parentSku || p.sku,
                etiqueta: (p.group?.name || p.aiTitle || p.name || p.sku).slice(0, 120),
                variantes: 1,
                estado: 'en_cola',
                mensaje: null,
                actualizado: ahora,
            });
        }
        // El grupo se regenera completo aunque solo se haya marcado una de sus variantes: se cuentan todas las que tiene.
        for (const item of items.values()) {
            if (item.grupoId) item.variantes = Math.max(item.variantes, await this.productos.count({ where: { group: { id: item.grupoId } } as any }));
        }
        const tope = maxPorTanda();
        if (items.size > tope) {
            throw new BadRequestException(`Seleccionaste ${items.size} productos (los grupos de variantes cuentan como uno). El máximo por tanda es ${tope}: divídelo en varias tandas.`);
        }

        const lote: LoteDeRegeneracion = { id: randomUUID(), storeId: ambito.storeId, userId: ambito.userId, creado: ahora, items: [...items.values()] };
        this.enMemoria.set(lote.id, lote);
        await this.guardar(lote);
        const foto: LoteDeRegeneracion = { ...lote, items: lote.items.map((i) => ({ ...i })) }; // lo que se devuelve no cambia por debajo
        void this.ejecutar(lote, opciones); // en segundo plano: la respuesta no espera a la IA
        return foto;
    }

    /** Avance de una tanda. Lo «en cola» o «generando» que lleva mucho sin novedades se marca como interrumpido. */
    async estado(ambito: Ambito, loteId: string): Promise<LoteDeRegeneracion & { terminado: boolean; total: number; terminados: number }> {
        const lote = this.enMemoria.get(loteId) ?? (await this.leer(loteId));
        if (!lote || lote.storeId !== ambito.storeId) throw new NotFoundException('No se encontró esa regeneración.');
        const viva = this.enMemoria.has(loteId);
        const ahora = Date.now();
        for (const i of lote.items) {
            if (!viva && (i.estado === 'en_cola' || i.estado === 'generando') && ahora - i.actualizado > INTERRUMPIDO_MS) {
                i.estado = 'error';
                i.mensaje = 'Se interrumpió (el servidor se reinició). Vuelve a intentarlo con este producto.';
            }
        }
        const terminados = lote.items.filter((i) => i.estado !== 'en_cola' && i.estado !== 'generando').length;
        return { ...lote, items: lote.items.map((i) => ({ ...i })), total: lote.items.length, terminados, terminado: terminados === lote.items.length };
    }

    private async ejecutar(lote: LoteDeRegeneracion, opciones: { tone?: string; marketplaces?: string[]; sobrescribir?: boolean }): Promise<void> {
        const ambito = { userId: lote.userId, storeId: lote.storeId };
        try {
            await Promise.all(lote.items.map(async (item) => {
                await this.semaforo.adquirir();
                try {
                    await this.marcar(lote, item, 'generando', null);
                    const r = item.grupoId
                        ? await this.groups.regenerarContenido(item.grupoId, { tone: opciones.tone, marketplaces: opciones.marketplaces, soloVacio: !opciones.sobrescribir }, ambito)
                        : await this.products.generateAIContent(item.productId, lote.userId, { tone: opciones.tone, marketplaces: opciones.marketplaces, soloVacio: !opciones.sobrescribir }, lote.storeId);
                    const llenado: string[] = (r as any)?.llenado ?? [];
                    if (opciones.sobrescribir) {
                        const alcance = item.grupoId && item.variantes > 1 ? ` en las ${item.variantes} variantes` : '';
                        await this.marcar(lote, item, 'listo', `Rehice el contenido${alcance}.`);
                    } else if (llenado.length) {
                        const alcance = item.grupoId && item.variantes > 1 ? ` (en las ${item.variantes} variantes)` : '';
                        await this.marcar(lote, item, 'listo', `Llené: ${llenado.join(', ')}${alcance}.`);
                    } else {
                        await this.marcar(lote, item, 'sin_cambios', 'Ya estaba completo: no había nada vacío que llenar.');
                    }
                } catch (error: any) {
                    const motivo = String(error?.response?.message ?? error?.message ?? 'La IA no pudo generar el contenido.');
                    await this.marcar(lote, item, 'error', motivo.slice(0, 240));
                } finally {
                    this.semaforo.liberar();
                }
            }));
        } finally {
            this.enMemoria.delete(lote.id);
        }
    }

    private async marcar(lote: LoteDeRegeneracion, item: ItemDeRegeneracion, estado: EstadoDeRegeneracion, mensaje: string | null): Promise<void> {
        item.estado = estado;
        item.mensaje = mensaje;
        item.actualizado = Date.now();
        await this.guardar(lote);
    }

    /** ¿Hay una tanda de esta tienda todavía corriendo en este proceso? */
    private async loteActivo(storeId: string): Promise<boolean> {
        for (const l of this.enMemoria.values()) {
            if (l.storeId === storeId && l.items.some((i) => i.estado === 'en_cola' || i.estado === 'generando')) return true;
        }
        return false;
    }

    private async guardar(lote: LoteDeRegeneracion): Promise<void> {
        try { await this.redis.set(clave(lote.id), JSON.stringify(lote), 'EX', TTL_SEGUNDOS); } catch { /* sin Redis el avance sigue en memoria */ }
    }

    private async leer(id: string): Promise<LoteDeRegeneracion | null> {
        try {
            const crudo = await this.redis.get(clave(id));
            return crudo ? (JSON.parse(crudo) as LoteDeRegeneracion) : null;
        } catch { return null; }
    }
}
