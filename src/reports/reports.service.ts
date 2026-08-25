import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { MarketplaceOrder } from '../sync/entities/marketplace-order.entity';
import { ClientProfile } from '../admin/entities/client-profile.entity';
import { parseAmount } from '../common/parse-amount';

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
    ) { }

    /**
     * Reporte externo configurado por el administrador para este usuario
     * (AppScript, Looker Studio...). Se sirve aparte del reporte nativo
     * para que el cliente vea ambos.
     */
    async getReportConfig(userId: string) {
        const profile = await this.profileRepository.findOne({
            where: { user: { id: userId } },
        });
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
    async getSalesReport(userId: string, from?: string, to?: string) {
        const end = to || new Date().toISOString().slice(0, 10);
        const start = from || new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);

        // ── Fuente 1: órdenes de marketplaces ──
        const rows = await this.orderRepository.createQueryBuilder('o')
            .select(`TO_CHAR("o"."orderDate"::date, 'YYYY-MM-DD')`, 'date')
            .addSelect('"o"."marketplace"', 'channel')
            .addSelect('SUM("o"."totalAmount")', 'sales')
            .addSelect('COUNT(*)', 'orders')
            .where('"o"."ownerId" = :userId', { userId })
            .andWhere('"o"."orderDate"::date BETWEEN :start AND :end', { start, end })
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
        const profile = await this.profileRepository.findOne({ where: { user: { id: userId } } });

        if (profile?.sheetCsvUrl) {
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

        const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
        const byChannel = [...byChannelMap.values()].sort((a, b) => b.sales - a.sales);
        const totalSales = byDay.reduce((s, d) => s + d.sales, 0);
        const totalOrders = byDay.reduce((s, d) => s + d.orders, 0);

        return {
            range: { from: start, to: end },
            totals: {
                sales: Math.round(totalSales * 100) / 100,
                orders: totalOrders,
                avgTicket: totalOrders ? Math.round((totalSales / totalOrders) * 100) / 100 : 0,
            },
            byDay,
            byChannel,
            sources: {
                marketplaces: rows.length > 0,
                sheets: Boolean(profile?.sheetCsvUrl),
                sheetError,
            },
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
