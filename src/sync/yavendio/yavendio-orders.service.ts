import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { resolverMoneda } from '../../common/currency';
import { ListingLink } from '../entities/listing-link.entity';
import { MarketplaceOrder } from '../entities/marketplace-order.entity';
import { SyncScope, SyncService } from '../sync.service';
import { YavendioApiService, YavendioOrder } from './yavendio-api.service';
import { importeProductosYavendio, normalizarPedidoYavendio, situacionDelPedido } from './yavendio-orders';

const MARKETPLACE = 'yavendio';
/** Pedidos nuevos cuyo detalle se pide en una pasada: cada uno es una llamada a Yavendió. */
const MAX_DETALLES_POR_PASADA = 200;
const DIAS_POR_DEFECTO = 90;

export interface OpcionesDePedidos {
    /** Cuenta qué pasaría sin guardar nada. */
    dryRun?: boolean;
    /** Cuántos días hacia atrás se miran los pedidos (90 por defecto). */
    dias?: number;
}

export interface ResultadoDePedidos {
    revisados: number;
    nuevos: number;
    actualizados: number;
    anulados: number;
    omitidos: number;
    /** Quedaron pedidos nuevos por traer: se vuelve a ejecutar para seguir. */
    pendientesPorTraer: number;
    /** Líneas cuya variante de Yavendió no está vinculada a ningún producto de Synkro. */
    lineasSinVincular: { pedido: string; producto: string; variantId: string | null }[];
}

/**
 * Lleva los pedidos de Yavendió a la tabla de ventas común, donde ya están las de los demás canales, para que
 * entren en los reportes y el panel de ventas. Solo registra: no descuenta stock (un historial no debe tocarlo)
 * ni manda correos. Cada línea se asocia al producto de Synkro por el id de variante de Yavendió, que es exacto.
 */
@Injectable()
export class YavendioOrdersService {
    private readonly logger = new Logger(YavendioOrdersService.name);

    constructor(
        @InjectRepository(MarketplaceOrder) private readonly orderRepository: Repository<MarketplaceOrder>,
        @InjectRepository(ListingLink) private readonly listingLinkRepository: Repository<ListingLink>,
        private readonly api: YavendioApiService,
        private readonly sync: SyncService,
    ) { }

    async import(scope: SyncScope, connectionId: string | undefined, opciones: OpcionesDePedidos = {}): Promise<ResultadoDePedidos> {
        const connection = await this.sync.resolveConnection(scope.storeId, MARKETPLACE, connectionId);
        const apiKey = connection.accessToken;
        const dias = Math.min(Math.max(Number(opciones.dias) || DIAS_POR_DEFECTO, 1), 3650);
        const desde = Date.now() - dias * 24 * 3600 * 1000;

        const filas = (await this.api.listOrders(apiKey))
            .filter((o) => {
                const t = Date.parse(o.order_date);
                return Number.isNaN(t) || t >= desde;
            })
            .sort((a, b) => Date.parse(b.order_date) - Date.parse(a.order_date));

        const guardadas = new Map<string, MarketplaceOrder>();
        for (const o of await this.orderRepository.find({ where: { marketplace: MARKETPLACE, connection: { id: connection.id } } })) guardadas.set(o.externalId, o);

        const vinculos = new Map<string, ListingLink>();
        const enlaces = await this.listingLinkRepository.find({
            where: { marketplace: MARKETPLACE, connection: { id: connection.id }, syncStatus: Not('removed') },
            relations: { product: true },
        });
        for (const e of enlaces) if (e.variationId) vinculos.set(String(e.variationId), e);

        const resultado: ResultadoDePedidos = { revisados: filas.length, nuevos: 0, actualizados: 0, anulados: 0, omitidos: 0, pendientesPorTraer: 0, lineasSinVincular: [] };
        let detalles = 0;

        for (const fila of filas) {
            const id = String(fila.id);
            const situacion = situacionDelPedido(fila.status);
            const existente = guardadas.get(id);

            if (existente) {
                if (situacion === 'anulado') {
                    // Un pedido cancelado ya no es una venta: se quita para que no sume en los reportes.
                    if (!opciones.dryRun) await this.orderRepository.delete(existente.id);
                    resultado.anulados++;
                } else if (this.cambioDeEstado(existente, fila)) {
                    if (!opciones.dryRun) await this.actualizarEstado(existente, fila);
                    resultado.actualizados++;
                }
                continue;
            }
            if (situacion !== 'venta') { resultado.omitidos++; continue; }

            if (detalles >= MAX_DETALLES_POR_PASADA) { resultado.pendientesPorTraer++; continue; }
            detalles++;
            const detalle = await this.api.getOrder(apiKey, fila.id);
            const pedido = normalizarPedidoYavendio(detalle);
            if (pedido.situacion !== 'venta') { resultado.omitidos++; continue; }

            for (const linea of pedido.normalized.lines) {
                const enlace = linea.channelVariationId ? vinculos.get(linea.channelVariationId) : undefined;
                if (enlace) {
                    linea.productId = enlace.product.id;
                    linea.sku = enlace.product.sku;
                } else if (resultado.lineasSinVincular.length < 30) {
                    resultado.lineasSinVincular.push({ pedido: id, producto: linea.title, variantId: linea.channelVariationId ?? null });
                }
            }

            if (!opciones.dryRun) {
                try {
                    await this.orderRepository.save(this.orderRepository.create({
                        marketplace: MARKETPLACE,
                        externalId: id,
                        owner: { id: connection.owner.id } as any,
                        store: connection.store ? ({ id: connection.store.id } as any) : null,
                        connection: { id: connection.id } as any,
                        totalAmount: pedido.totalAmount,
                        productsAmount: importeProductosYavendio(pedido),
                        currency: resolverMoneda(pedido.currency, (connection.secrets as any)?.currency),
                        itemsCount: pedido.normalized.lines.reduce((s, l) => s + Number(l.quantity || 0), 0) || 1,
                        items: pedido.normalized.lines as any,
                        orderNumber: pedido.normalized.orderNumber,
                        customerName: pedido.normalized.customerName,
                        shipByDate: pedido.normalized.shipByDate,
                        details: pedido.normalized.details as any,
                        status: 'paid',
                        orderDate: pedido.orderDate,
                    }));
                } catch (error: any) {
                    // 23505: ya estaba registrada (dos pasadas a la vez); cualquier otro fallo sí se informa.
                    if (error?.code !== '23505') throw error;
                    continue;
                }
            }
            resultado.nuevos++;
        }

        this.logger.log(`Pedidos de Yavendió${opciones.dryRun ? ' (simulado)' : ''}: ${resultado.nuevos} nuevos, ${resultado.actualizados} actualizados, ${resultado.anulados} anulados, ${resultado.omitidos} omitidos de ${resultado.revisados}.`);
        return resultado;
    }

    private cambioDeEstado(existente: MarketplaceOrder, fila: YavendioOrder): boolean {
        return String(fila.status ?? '') !== String(existente.details?.channelStatus ?? '');
    }

    private async actualizarEstado(existente: MarketplaceOrder, fila: YavendioOrder): Promise<void> {
        const estado = String(fila.status ?? '').toLowerCase() || null;
        const detalles = existente.details ?? {};
        await this.orderRepository.update(existente.id, {
            details: { ...detalles, channelStatus: estado, shipping: { ...(detalles.shipping ?? {}), status: estado } } as any,
        });
    }
}
