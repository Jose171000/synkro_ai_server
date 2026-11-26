import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import { BulkBatch } from './entities/bulk-batch.entity';
import { BulkBatchItem } from './entities/bulk-batch-item.entity';

export interface ResumenDeLote {
    total: number;
    processed: number;
    failed: number;
    terminado: boolean;
    /** Productos que no se pudieron crear y por qué. */
    fallidos: { sku: string; error: string }[];
    /** Filas del Excel que ni siquiera entraron a la cola. */
    rechazadas: string[];
    /** Cómo va el envío a Falabella (solo productos que van a ese canal). */
    falabella: { pendientes: number; enviados: number; rechazados: number };
    falabellaRechazados: { sku: string; error: string }[];
    /** Fallidos que ya se volvieron a mandar en otro lote. */
    reintentados: number;
}

export interface ParaReintentar {
    storeId: string | null;
    /** Un lote en marcha no se reintenta: sus pendientes todavía se están procesando. */
    puedeReintentarse: boolean;
    fallidos: { sku: string; payload: Record<string, any> }[];
    /** Productos ya creados que quedaron sin enviarse a Falabella. */
    falabellaPendientes: string[];
    /** Datos del trabajo original (canales, cuentas, usuario) para reenviar a Falabella. */
    payloadBase: Record<string, any> | null;
    archivo?: string | null;
}

export type EstadoDeCarga = 'en_cola' | 'procesando' | 'terminada' | 'detenida';

export interface CargaDelHistorial {
    id: string;
    archivo: string | null;
    creada: Date;
    terminadaEl: Date | null;
    estado: EstadoDeCarga;
    total: number;
    creados: number;
    fallidos: number;
    reintentados: number;
    /** Filas del Excel que no llegaron a la cola, con su motivo. */
    rechazadas: string[];
    falabella: { pendientes: number; enviados: number; rechazados: number };
    sePuedeReintentar: boolean;
}

export interface ProductoDeCarga {
    sku: string;
    estado: BulkBatchItem['status'];
    error: string | null;
    productId: string | null;
    falabella: string | null;
    falabellaError: string | null;
}

/** Lo que sigue «pendiente» en una carga más vieja que esto ya no se considera en cola. */
const HORAS_EN_COLA = 12;
/** Sin ningún cambio en este tiempo, una carga vieja se muestra como detenida. */
const MINUTOS_SIN_AVANCE = 30;
const MAX_HISTORIAL = 50;

/** Un lote en marcha más viejo que esto se da por trabado (Redis perdió su cuenta) y puede reintentarse. */
const HORAS_PARA_DAR_POR_TRABADO = 2;

/**
 * Registro durable de las cargas masivas. Redis sigue llevando la cuenta y el cierre del lote; esto guarda lo que queda
 * cuando Redis caduca o se reinicia. Ningún método lanza: un fallo al anotar un producto no debe tumbar su creación.
 */
@Injectable()
export class BulkBatchService {
    private readonly logger = new Logger(BulkBatchService.name);

    constructor(
        @InjectRepository(BulkBatch) private readonly lotes: Repository<BulkBatch>,
        @InjectRepository(BulkBatchItem) private readonly items: Repository<BulkBatchItem>,
    ) { }

    private async seguro<T>(que: string, tarea: () => Promise<T>): Promise<T | undefined> {
        try {
            return await tarea();
        } catch (error: any) {
            this.logger.warn(`No se pudo ${que}: ${error?.message}`);
            return undefined;
        }
    }

    /** Anota el lote y un renglón pendiente por cada producto que entró a la cola. */
    async crear(
        batchId: string,
        userId: string,
        storeId: string | undefined,
        items: { sku: string; payload: Record<string, any> }[],
        rechazadas: string[] = [],
        archivo?: string | null,
    ): Promise<void> {
        await this.seguro('anotar el lote', async () => {
            await this.lotes.save(this.lotes.create({ id: batchId, userId, storeId: storeId ?? null, total: items.length, status: 'running', rejected: rechazadas, fileName: archivo?.slice(0, 200) || null }));
            // De a 200 renglones por inserción: un Excel de mil filas no arma una consulta gigante.
            for (let i = 0; i < items.length; i += 200) {
                await this.items.save(items.slice(i, i + 200).map((x) => this.items.create({ batchId, sku: x.sku, status: 'pendiente', payload: x.payload })));
            }
        });
    }

    /** Anota cómo terminó un producto. Con reintentos, el último resultado manda. */
    async marcar(batchId: string, sku: string, resultado: { ok: boolean; productId?: string; error?: string }): Promise<void> {
        await this.seguro('anotar el producto del lote', async () => {
            await this.items.update(
                { batchId, sku },
                resultado.ok
                    ? { status: 'listo', error: null, productId: resultado.productId ?? null }
                    : { status: 'fallido', error: (resultado.error ?? 'error desconocido').slice(0, 500) },
            );
        });
    }

    /** El producto quedó esperando su tanda de envío a Falabella. */
    async falabellaPendiente(batchId: string, productId: string): Promise<void> {
        await this.seguro('anotar el producto pendiente de Falabella', async () => {
            await this.items.update({ batchId, productId }, { falabellaStatus: 'pendiente', falabellaError: null });
        });
    }

    /**
     * Resultado de una tanda: todos los productos de la tanda pasan a «enviado» y los que Falabella no aceptó, a «rechazado» con su motivo.
     * Lo que ya existía en Falabella (se vincula, no se vuelve a publicar) cuenta como enviado.
     */
    async falabellaResultado(batchId: string, productIds: string[], rechazados: { sku: string; motivo: string }[]): Promise<void> {
        await this.seguro('anotar el resultado de la tanda de Falabella', async () => {
            if (productIds.length) await this.items.update({ batchId, productId: In(productIds) }, { falabellaStatus: 'enviado', falabellaError: null });
            for (const r of rechazados) {
                if (/^ya (está publicado|existía)/i.test(r.motivo)) continue;
                await this.items.update({ batchId, sku: r.sku }, { falabellaStatus: 'rechazado', falabellaError: r.motivo.slice(0, 500) });
            }
        });
    }

    /** Productos del lote que siguen esperando su envío a Falabella (por ejemplo, si Redis perdió la lista). */
    async pendientesDeFalabella(batchId: string): Promise<string[]> {
        const filas = await this.seguro('leer los pendientes de Falabella', () => this.items.find({ where: { batchId, falabellaStatus: 'pendiente' }, select: ['productId'] }));
        return (filas ?? []).map((f) => f.productId).filter((id): id is string => !!id);
    }

    /** Cierra el lote (cuando Redis dice que llegó al total). */
    async cerrar(batchId: string): Promise<void> {
        await this.seguro('cerrar el lote', async () => {
            await this.lotes.update({ id: batchId }, { status: 'done', finishedAt: new Date() });
        });
    }

    /** El estado de un lote desde la base (solo para quien lo subió). null si no existe. */
    async resumen(batchId: string, userId: string): Promise<ResumenDeLote | null> {
        const lote = await this.seguro('leer el lote', () => this.lotes.findOne({ where: { id: batchId } }));
        if (!lote || lote.userId !== userId) return null;
        const items = (await this.seguro('leer los productos del lote', () => this.items.find({ where: { batchId }, select: ['sku', 'status', 'error', 'falabellaStatus', 'falabellaError'] }))) ?? [];
        const processed = items.filter((i) => i.status === 'listo').length;
        const fallidos = items.filter((i) => i.status === 'fallido').map((i) => ({ sku: i.sku, error: i.error ?? '' }));
        return {
            total: lote.total,
            processed,
            failed: fallidos.length,
            terminado: lote.status === 'done' || processed + fallidos.length >= lote.total,
            fallidos,
            rechazadas: lote.rejected ?? [],
            falabella: {
                pendientes: items.filter((i) => i.falabellaStatus === 'pendiente').length,
                enviados: items.filter((i) => i.falabellaStatus === 'enviado').length,
                rechazados: items.filter((i) => i.falabellaStatus === 'rechazado').length,
            },
            falabellaRechazados: items.filter((i) => i.falabellaStatus === 'rechazado').map((i) => ({ sku: i.sku, error: i.falabellaError ?? '' })),
            reintentados: items.filter((i) => i.status === 'reintentado').length,
        };
    }

    /** Lo que se puede volver a mandar de un lote: productos fallidos (con sus datos) y los que quedaron sin enviar a Falabella. */
    async paraReintentar(batchId: string, userId: string): Promise<ParaReintentar | null> {
        const lote = await this.seguro('leer el lote', () => this.lotes.findOne({ where: { id: batchId } }));
        if (!lote || lote.userId !== userId) return null;
        const items = (await this.seguro('leer los productos del lote', () => this.items.find({ where: { batchId } }))) ?? [];
        const viejo = Date.now() - new Date(lote.createdAt).getTime() > HORAS_PARA_DAR_POR_TRABADO * 3_600_000;
        return {
            storeId: lote.storeId ?? null,
            puedeReintentarse: lote.status === 'done' || viejo,
            fallidos: items.filter((i) => i.status === 'fallido' && i.payload).map((i) => ({ sku: i.sku, payload: i.payload! })),
            falabellaPendientes: items.filter((i) => i.falabellaStatus === 'pendiente' && i.productId).map((i) => i.productId!),
            payloadBase: items.find((i) => i.payload)?.payload ?? null,
            archivo: lote.fileName ?? null,
        };
    }

    /**
     * SKU (y códigos de grupo) de la tienda que están en una carga sin terminar de procesarse, en minúsculas. Todavía no existen como
     * productos: sin esto otro Excel podría repetirlos o recibir el mismo número generado.
     */
    async skusEnCola(userId: string, storeId: string | undefined): Promise<Set<string>> {
        const claves = await this.seguro('leer los SKU en cola', async () => {
            const desde = new Date(Date.now() - HORAS_EN_COLA * 3_600_000);
            const lotes = await this.lotes.find({ where: { ...(storeId ? { storeId } : { userId }), status: 'running', createdAt: MoreThan(desde) } });
            if (!lotes.length) return [];
            const items = await this.items.find({ where: { batchId: In(lotes.map((l) => l.id)), status: 'pendiente' }, select: ['sku', 'payload'] });
            return items.flatMap((i) => [i.sku, i.payload?.parentSku]).filter(Boolean).map((s: string) => String(s).trim().toLowerCase());
        });
        return new Set(claves ?? []);
    }

    /** Las últimas cargas que esta persona subió en la tienda, con cómo va cada una. */
    async historial(userId: string, storeId: string | undefined): Promise<CargaDelHistorial[]> {
        const lotes = await this.lotes.find({ where: { userId, ...(storeId ? { storeId } : {}) }, order: { createdAt: 'DESC' }, take: MAX_HISTORIAL });
        if (!lotes.length) return [];
        const items = await this.items.find({ where: { batchId: In(lotes.map((l) => l.id)) }, select: ['batchId', 'status', 'falabellaStatus', 'updatedAt'] });
        const porLote = new Map<string, BulkBatchItem[]>();
        for (const i of items) porLote.set(i.batchId, [...(porLote.get(i.batchId) ?? []), i]);

        return lotes.map((lote) => {
            const suyos = porLote.get(lote.id) ?? [];
            const cuantos = (estado: BulkBatchItem['status']) => suyos.filter((i) => i.status === estado).length;
            const enFalabella = (estado: string) => suyos.filter((i) => i.falabellaStatus === estado).length;
            const creados = cuantos('listo');
            const fallidos = cuantos('fallido');
            const reintentados = cuantos('reintentado');
            const terminada = lote.status === 'done' || creados + fallidos + reintentados >= lote.total;
            const antiguedad = Date.now() - new Date(lote.createdAt).getTime();
            const ultimoCambio = Math.max(new Date(lote.createdAt).getTime(), ...suyos.map((i) => new Date(i.updatedAt ?? 0).getTime() || 0));
            const vieja = antiguedad > HORAS_PARA_DAR_POR_TRABADO * 3_600_000;
            const estado: EstadoDeCarga = terminada
                ? 'terminada'
                : vieja && Date.now() - ultimoCambio > MINUTOS_SIN_AVANCE * 60_000
                    ? 'detenida'
                    : creados + fallidos ? 'procesando' : 'en_cola';
            return {
                id: lote.id,
                archivo: lote.fileName ?? null,
                creada: lote.createdAt,
                terminadaEl: lote.finishedAt ?? null,
                estado,
                total: lote.total,
                creados,
                fallidos,
                reintentados,
                rechazadas: lote.rejected ?? [],
                falabella: { pendientes: enFalabella('pendiente'), enviados: enFalabella('enviado'), rechazados: enFalabella('rechazado') },
                sePuedeReintentar: (lote.status === 'done' || vieja) && (fallidos > 0 || (terminada && enFalabella('pendiente') > 0)),
            };
        });
    }

    /** Los productos de una carga, uno por uno (solo para quien la subió). null si no existe. */
    async productosDeLaCarga(batchId: string, userId: string): Promise<ProductoDeCarga[] | null> {
        const lote = await this.lotes.findOne({ where: { id: batchId } });
        if (!lote || lote.userId !== userId) return null;
        const items = await this.items.find({ where: { batchId }, select: ['sku', 'status', 'error', 'productId', 'falabellaStatus', 'falabellaError', 'createdAt'], order: { createdAt: 'ASC', sku: 'ASC' } });
        return items.map((i) => ({ sku: i.sku, estado: i.status, error: i.error ?? null, productId: i.productId ?? null, falabella: i.falabellaStatus ?? null, falabellaError: i.falabellaError ?? null }));
    }

    /** Anota que estos productos fallidos ya salieron en otro lote, para no reintentarlos dos veces. */
    async marcarReintentados(batchId: string, skus: string[]): Promise<void> {
        await this.seguro('anotar los reintentos', async () => {
            if (skus.length) await this.items.update({ batchId, sku: In(skus), status: 'fallido' }, { status: 'reintentado' });
        });
    }
}
