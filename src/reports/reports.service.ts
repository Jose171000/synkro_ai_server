import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { MarketplaceOrder } from '../sync/entities/marketplace-order.entity';
import { ESTADOS_DE_VENTA, ESTADOS_QUE_NO_CUENTAN } from '../sync/estado-de-venta';
import { TIPOS_DE_ENVIO } from '../sync/costos-de-venta';
import { hoyEnLima } from '../admin/plan-comercial';
import { estadosPedidos } from '../sync/orders-query.service';
import { ClientProfile } from '../admin/entities/client-profile.entity';
import { parseAmount } from '../common/parse-amount';
import { Store } from '../stores/entities/store.entity';
import { StoresService } from '../stores/stores.service';

export interface DayPoint {
    date: string;          // YYYY-MM-DD
    sales: number;
    orders: number;
}

@Injectable()
export class ReportsService {
    constructor(
        @InjectRepository(MarketplaceOrder)
        private readonly orderRepository: Repository<MarketplaceOrder>,
        @InjectRepository(ClientProfile)
        private readonly profileRepository: Repository<ClientProfile>,
        @InjectRepository(Store)
        private readonly storeRepository: Repository<Store>,
        private readonly stores: StoresService,
    ) { }

    /**
     * El perfil del cliente (reporte externo y Google Sheet) es de la cuenta,
     * no de cada tienda. Se asocia a la tienda ORIGINAL de su dueño: es la que
     * existía cuando se configuró. Las demás tiendas parten con sus métricas
     * propias, sin heredar las de otra.
     */
    private async legacyProfile(storeId: string): Promise<ClientProfile | null> {
        const store = await this.storeRepository.findOne({ where: { id: storeId }, relations: { owner: true } });
        if (!store) return null;
        const original = await this.stores.defaultStoreId(store.owner.id);
        if (original !== storeId) return null;
        return this.profileRepository.findOne({ where: { user: { id: store.owner.id } } });
    }

    /**
     * Reporte externo configurado por el administrador para este usuario
     * (AppScript, Looker Studio...). Se sirve aparte del reporte nativo
     * para que el cliente vea ambos.
     */
    async getReportConfig(storeId: string) {
        const profile = await this.legacyProfile(storeId);
        return {
            embedUrl: profile?.reportEmbedUrl || null,
            embedTitle: profile?.reportEmbedTitle || 'Reporte detallado',
        };
    }

    /**
     * Comprueba si una URL puede mostrarse dentro de un iframe.
     * Google Apps Script responde SAMEORIGIN salvo que el script use
     * XFrameOptionsMode.ALLOWALL, así que conviene avisar al admin antes
     * de que el cliente se encuentre un recuadro en blanco.
     */
    async checkEmbeddable(url: string) {
        try {
            const response = await axios.get(url, {
                timeout: 12000,
                maxRedirects: 5,
                validateStatus: () => true,
                // Basta con las cabeceras, pero Apps Script no admite HEAD
                responseType: 'text',
            });

            const headers = response.headers as Record<string, string>;
            const xFrame = (headers['x-frame-options'] || '').toUpperCase();
            const csp = headers['content-security-policy'] || '';
            const frameAncestors = /frame-ancestors\s+([^;]+)/i.exec(csp)?.[1]?.trim();

            const blockedByXFrame = xFrame.includes('DENY') || xFrame.includes('SAMEORIGIN');

            // frame-ancestors bloquea salvo que permita cualquiera (*) o
            // nombre explícitamente a nuestro dominio.
            const allowsUs = frameAncestors
                ? frameAncestors.includes('*') || /synkroai\.com/i.test(frameAncestors)
                : true;
            const blockedByCsp = Boolean(frameAncestors) && !allowsUs;

            const embeddable = response.status < 400 && !blockedByXFrame && !blockedByCsp;

            let reason: string | null = null;
            if (response.status >= 400) {
                reason = `La URL respondió ${response.status}. Revisa que el enlace sea público.`;
            } else if (blockedByXFrame) {
                reason =
                    'El sitio no permite mostrarse dentro de otra página (X-Frame-Options: ' +
                    `${xFrame}). Si es un Google Apps Script, añade ` +
                    '.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL) al HtmlOutput.';
            } else if (blockedByCsp) {
                reason = `El sitio restringe qué páginas pueden embeberlo (frame-ancestors: ${frameAncestors}).`;
            }

            return { embeddable, status: response.status, xFrameOptions: xFrame || null, frameAncestors: frameAncestors || null, reason };
        } catch (error: any) {
            return {
                embeddable: false,
                status: null,
                xFrameOptions: null,
                frameAncestors: null,
                reason: `No se pudo abrir la URL: ${error?.message}`,
            };
        }
    }

    /**
     * Sales report for a client, combining two sources:
     *  - marketplace_orders (real orders synced from marketplaces)
     *  - the client's Google Sheet published as CSV (legacy AppScript data)
     */
    /**
     * `verCostos` es el permiso «costos.ver»: sin él no se devuelven el envío ni los cupones, y las ventas son solo lo vendido
     * (nunca suman lo que el cliente pagó por el envío).
     */
    async getSalesReport(storeId: string, from?: string, to?: string, status?: string, incluirEnvio = true, verCostos = true) {
        if (!verCostos) incluirEnvio = false;
        const estados = estadosPedidos(status);
        const hoy = hoyEnLima();
        const end = to || hoy;
        const start = from || new Date(new Date(`${hoy}T12:00:00Z`).getTime() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);

        // El día de una venta es el de Lima (no el de la base de datos, que va en hora universal).
        const FECHA = `("o"."orderDate" AT TIME ZONE 'America/Lima')::date`;
        // Lo que pagó el cliente: los productos y, con el interruptor, también el envío. Una venta sin desglose usa su total.
        const VENTA = incluirEnvio
            ? 'CASE WHEN "o"."productsAmount" IS NULL THEN "o"."totalAmount" ELSE "o"."productsAmount" + "o"."shippingPaid" END'
            : 'COALESCE("o"."productsAmount", "o"."totalAmount")';
        const n = (v: unknown) => Number(v ?? 0) || 0;
        const r2 = (v: unknown) => Math.round(n(v) * 100) / 100;

        // ── Fuente 1: órdenes de marketplaces ──
        const rows = await this.orderRepository.createQueryBuilder('o')
            .select(`TO_CHAR(${FECHA}, 'YYYY-MM-DD')`, 'date')
            .addSelect('"o"."marketplace"', 'channel')
            .addSelect(`SUM(${VENTA})`, 'sales')
            .addSelect('COUNT(*)', 'orders')
            .where('"o"."storeId" = :storeId', { storeId })
            .andWhere(`${FECHA} BETWEEN :start AND :end`, { start, end })
            // Sin estado elegido cuentan las ventas concretadas (no las canceladas ni devueltas); eligiéndolo se ve ese estado.
            .andWhere(estados.length ? '"o"."saleState" IN (:...estados)' : '"o"."saleState" NOT IN (:...fuera)', { estados, fuera: ESTADOS_QUE_NO_CUENTAN })
            .groupBy('date').addGroupBy('"o"."marketplace"')
            .orderBy('date', 'ASC')
            .getRawMany();

        const byDayMap = new Map<string, DayPoint>();
        const byChannelMap = new Map<string, { channel: string; sales: number; orders: number; source: string }>();

        for (const r of rows) {
            const day = byDayMap.get(r.date) || { date: r.date, sales: 0, orders: 0 };
            day.sales += Number(r.sales);
            day.orders += Number(r.orders);
            byDayMap.set(r.date, day);

            const ch = byChannelMap.get(r.channel) || { channel: r.channel, sales: 0, orders: 0, source: 'marketplace' };
            ch.sales += Number(r.sales);
            ch.orders += Number(r.orders);
            byChannelMap.set(r.channel, ch);
        }

        // ── Fuente 2: Google Sheets (CSV publicado) ──
        let sheetError: string | null = null;
        const profile = await this.legacyProfile(storeId);

        // El Google Sheet no tiene estado de venta: con un filtro de estado no se mezcla.
        if (profile?.sheetCsvUrl && !estados.length) {
            try {
                const sheetRows = await this.fetchSheetRows(profile.sheetCsvUrl);
                for (const row of sheetRows) {
                    if (row.date < start || row.date > end) continue;

                    const day = byDayMap.get(row.date) || { date: row.date, sales: 0, orders: 0 };
                    day.sales += row.sales;
                    day.orders += row.orders;
                    byDayMap.set(row.date, day);

                    const key = row.channel || 'sheets';
                    const ch = byChannelMap.get(key) || { channel: key, sales: 0, orders: 0, source: 'sheets' };
                    ch.sales += row.sales;
                    ch.orders += row.orders;
                    byChannelMap.set(key, ch);
                }
            } catch (error: any) {
                sheetError = `No se pudo leer el Google Sheet: ${error?.message}`;
            }
        }

        // ── Por cuenta: una tienda puede tener varias del mismo canal ──
        const porCuenta = await this.orderRepository.createQueryBuilder('o')
            .leftJoin('o.connection', 'c')
            .select('"o"."connectionId"', 'connectionId')
            .addSelect('"o"."marketplace"', 'channel')
            .addSelect('MAX(COALESCE("c"."label", "c"."externalNickname", "c"."externalUserId"))', 'label')
            .addSelect(`SUM(${VENTA})`, 'sales')
            .addSelect('COUNT(*)', 'orders')
            .where('"o"."storeId" = :storeId', { storeId })
            .andWhere(`${FECHA} BETWEEN :start AND :end`, { start, end })
            // Sin estado elegido cuentan las ventas concretadas (no las canceladas ni devueltas); eligiéndolo se ve ese estado.
            .andWhere(estados.length ? '"o"."saleState" IN (:...estados)' : '"o"."saleState" NOT IN (:...fuera)', { estados, fuera: ESTADOS_QUE_NO_CUENTAN })
            .groupBy('"o"."connectionId"').addGroupBy('"o"."marketplace"')
            .orderBy(`SUM(${VENTA})`, 'DESC')
            .getRawMany();

        // Cuántas ventas y cuánto hay en cada estado en el rango (para mostrar el número en cada opción del filtro).
        const porEstado = await this.orderRepository.createQueryBuilder('o')
            .select('"o"."saleState"', 'estado')
            .addSelect(`SUM(${VENTA})`, 'sales')
            .addSelect('COUNT(*)', 'orders')
            .where('"o"."storeId" = :storeId', { storeId })
            .andWhere(`${FECHA} BETWEEN :start AND :end`, { start, end })
            .groupBy('"o"."saleState"')
            .getRawMany();

        // Las mismas ventas que el resto del reporte (rango, estado elegido o concretadas), para envío, cupones y mapa de calor.
        const mismasVentas = () => this.orderRepository.createQueryBuilder('o')
            .where('"o"."storeId" = :storeId', { storeId })
            .andWhere(`${FECHA} BETWEEN :start AND :end`, { start, end })
            .andWhere(estados.length ? '"o"."saleState" IN (:...estados)' : '"o"."saleState" NOT IN (:...fuera)', { estados, fuera: ESTADOS_QUE_NO_CUENTAN });

        const envios = await mismasVentas()
            .select('"o"."shippingType"', 'tipo')
            .addSelect('"o"."marketplace"', 'channel')
            .addSelect('COUNT(*)', 'orders')
            .addSelect('COALESCE(SUM("o"."shippingPaid"), 0)', 'paid')
            .addSelect('COALESCE(SUM("o"."shippingSellerCost"), 0)', 'sellerCost')
            .addSelect('COUNT("o"."shippingSellerCost")', 'withCost')
            .groupBy('"o"."shippingType"').addGroupBy('"o"."marketplace"')
            .getRawMany();

        const cupones = await mismasVentas()
            .select('"o"."marketplace"', 'channel')
            .addSelect('COUNT(*) FILTER (WHERE "o"."discountAmount" > 0)', 'orders')
            .addSelect('COALESCE(SUM("o"."discountAmount"), 0)', 'amount')
            .addSelect('COALESCE(SUM("o"."discountSellerFunded"), 0)', 'sellerFunded')
            .addSelect('COUNT(*) FILTER (WHERE "o"."discountAmount" > 0 AND "o"."discountSellerFunded" IS NOT NULL)', 'knownOrders')
            .groupBy('"o"."marketplace"')
            .getRawMany();

        // Mapa de calor: día de la semana y hora (Lima). Las ventas registradas a mano no tienen hora real, así que no entran.
        const calor = await mismasVentas()
            .andWhere(`COALESCE("o"."details"->>'manual', '') <> 'true'`)
            .select(`EXTRACT(DOW FROM ("o"."orderDate" AT TIME ZONE 'America/Lima'))::int`, 'dow')
            .addSelect(`EXTRACT(HOUR FROM ("o"."orderDate" AT TIME ZONE 'America/Lima'))::int`, 'hour')
            .addSelect('COUNT(*)', 'orders')
            .addSelect(`SUM(${VENTA})`, 'sales')
            .groupBy('dow').addGroupBy('hour')
            .getRawMany();

        const ultima = await this.orderRepository.createQueryBuilder('o')
            .select('MAX("o"."orderDate")', 'last')
            .where('"o"."storeId" = :storeId', { storeId })
            .getRawOne();

        const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
        const byChannel = [...byChannelMap.values()].sort((a, b) => b.sales - a.sales);
        const totalSales = byDay.reduce((s, d) => s + d.sales, 0);
        const totalOrders = byDay.reduce((s, d) => s + d.orders, 0);

        const informe = {
            range: { from: start, to: end },
            totals: {
                sales: Math.round(totalSales * 100) / 100,
                orders: totalOrders,
                avgTicket: totalOrders ? Math.round((totalSales / totalOrders) * 100) / 100 : 0,
            },
            byDay,
            byChannel,
            /** Si las ventas incluyen lo que el cliente pagó por el envío (por defecto sí). */
            includeShipping: incluirEnvio,
            /** Cómo se pagó el envío: el comprador, gratis (lo cubres tú o el canal) o retiro en tienda; con el costo cuando el canal lo informa. */
            shipping: {
                paidTotal: r2(envios.reduce((t, r) => t + n(r.paid), 0)),
                byType: TIPOS_DE_ENVIO.map(tipo => {
                    const filas = envios.filter(r => r.tipo === tipo);
                    return {
                        type: tipo,
                        orders: filas.reduce((t, r) => t + n(r.orders), 0),
                        paid: r2(filas.reduce((t, r) => t + n(r.paid), 0)),
                        sellerCost: r2(filas.reduce((t, r) => t + n(r.sellerCost), 0)),
                        ordersWithCost: filas.reduce((t, r) => t + n(r.withCost), 0),
                    };
                }),
                byChannel: envios.map(r => ({ channel: r.channel, type: r.tipo, orders: n(r.orders), paid: r2(r.paid), sellerCost: r2(r.sellerCost), ordersWithCost: n(r.withCost) })),
            },
            /** Cupones y descuentos del canal al comprador, y la parte que cubre el vendedor cuando el canal lo dice. */
            discounts: {
                orders: cupones.reduce((t, r) => t + n(r.orders), 0),
                amount: r2(cupones.reduce((t, r) => t + n(r.amount), 0)),
                sellerFunded: r2(cupones.reduce((t, r) => t + n(r.sellerFunded), 0)),
                ordersWithKnownFunding: cupones.reduce((t, r) => t + n(r.knownOrders), 0),
                byChannel: cupones.map(r => ({ channel: r.channel, orders: n(r.orders), amount: r2(r.amount), sellerFunded: r2(r.sellerFunded), ordersWithKnownFunding: n(r.knownOrders) })).filter(c => c.orders > 0),
            },
            /** Ventas por día de la semana (0 = domingo) y hora (0-23), en hora de Lima. */
            heatmap: calor.map(r => ({ dow: n(r.dow), hour: n(r.hour), orders: n(r.orders), sales: r2(r.sales) })),
            byStatus: ESTADOS_DE_VENTA.map(e => {
                const r = porEstado.find(x => x.estado === e);
                return { status: e, orders: Number(r?.orders ?? 0), sales: Math.round(Number(r?.sales ?? 0) * 100) / 100 };
            }),
            statusFilter: estados,
            byAccount: porCuenta.map(r => ({
                connectionId: r.connectionId,
                channel: r.channel,
                label: r.label ?? null,
                sales: Math.round(Number(r.sales) * 100) / 100,
                orders: Number(r.orders),
            })),
            /** Cuándo entró la última venta de la tienda: sirve para saber si los canales están jalando. */
            lastOrderAt: ultima?.last ?? null,
            sources: {
                marketplaces: rows.length > 0,
                sheets: Boolean(profile?.sheetCsvUrl),
                sheetError,
            },
        };
        if (verCostos) return { ...informe, costsHidden: false };
        return {
            ...informe,
            costsHidden: true,
            shipping: { paidTotal: 0, byType: [], byChannel: [] },
            discounts: { orders: 0, amount: 0, sellerFunded: 0, ordersWithKnownFunding: 0, byChannel: [] },
        };
    }

    /**
     * Parses the published-CSV Google Sheet. Expected headers (flexible,
     * case-insensitive): fecha|date, canal|channel (opcional),
     * ventas|monto|amount|total, pedidos|orders (opcional).
     */
    private async fetchSheetRows(url: string): Promise<Array<{ date: string; channel: string | null; sales: number; orders: number }>> {
        const { data } = await axios.get(url, { timeout: 10000, responseType: 'text' });
        const lines = String(data).split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) return [];

        const headers = this.splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
        const idx = {
            date: headers.findIndex(h => ['fecha', 'date', 'dia', 'día'].includes(h)),
            channel: headers.findIndex(h => ['canal', 'channel', 'marketplace', 'tienda'].includes(h)),
            sales: headers.findIndex(h => ['ventas', 'monto', 'amount', 'total', 'importe'].includes(h)),
            orders: headers.findIndex(h => ['pedidos', 'orders', 'ordenes', 'órdenes', 'ventas_cantidad'].includes(h)),
        };
        if (idx.date === -1 || idx.sales === -1) {
            throw new Error('El sheet necesita al menos las columnas "fecha" y "ventas" (o "monto").');
        }

        const rows = [] as Array<{ date: string; channel: string | null; sales: number; orders: number }>;
        for (const line of lines.slice(1)) {
            const cols = this.splitCsvLine(line);
            const rawDate = (cols[idx.date] || '').trim();
            const date = this.normalizeDate(rawDate);
            if (!date) continue;

            const sales = parseAmount(cols[idx.sales]) ?? 0;
            const orders = idx.orders !== -1 ? (Number(String(cols[idx.orders] || '0').replace(/[^0-9]/g, '')) || 0) : 0;
            const channel = idx.channel !== -1 ? (cols[idx.channel] || '').trim().toLowerCase() || null : null;

            rows.push({ date, channel, sales, orders });
        }
        return rows;
    }

    private splitCsvLine(line: string): string[] {
        // Suficiente para sheets publicados: respeta comillas dobles simples
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        for (const char of line) {
            if (char === '"') { inQuotes = !inQuotes; continue; }
            if (char === ',' && !inQuotes) { result.push(current); current = ''; continue; }
            current += char;
        }
        result.push(current);
        return result;
    }

    private normalizeDate(raw: string): string | null {
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
        // dd/mm/yyyy o dd-mm-yyyy
        const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        return null;
    }
}
