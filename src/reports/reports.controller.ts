import { BadRequestException, Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ReportsService } from './reports.service';
import { CriterioDeOrden } from './productos-ganadores';
import { descargarFotos, reporteAExcel, reporteAPdf } from './reports-export';
import { RequirePermission, RequireStoreRole, StoreAccessGuard } from '../stores/store-access.guard';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, StoreAccessGuard)
@RequireStoreRole('viewer')
@Controller('reports')
export class ReportsController {
    constructor(private readonly reportsService: ReportsService) { }

    @Get('config')
    @RequirePermission('analiticas.ver')
    @ApiOperation({
        summary: 'Reporte externo configurado para la tienda activa',
        description: 'Devuelve la URL a embeber (AppScript, Looker Studio) si el administrador configuró una.',
    })
    getConfig(@Req() req) {
        return this.reportsService.getReportConfig(req.store.storeId);
    }

    @Get('sales')
    @RequirePermission('analiticas.ver')
    @ApiOperation({
        summary: 'Reporte de ventas de la tienda activa',
        description: 'Las ventas de las cuentas de la tienda (X-Store-Id), por día, canal y cuenta; en la tienda original del dueño se suma además el Google Sheet vinculado. Rango por defecto: últimos 30 días.',
    })
    @ApiQuery({ name: 'from', required: false, example: '2026-07-01' })
    @ApiQuery({ name: 'to', required: false, example: '2026-07-22' })
    @ApiQuery({ name: 'status', required: false, description: 'Solo ventas en este estado: pendiente, enviado, entregado, cancelado o devuelto (varios, separados por coma).' })
    @ApiQuery({ name: 'includeShipping', required: false, description: 'false para no sumar lo que el cliente pagó por el envío. Por defecto se incluye: las ventas son todo lo que pagó el cliente.' })
    getSales(@Req() req, @Query('from') from?: string, @Query('to') to?: string, @Query('status') status?: string, @Query('includeShipping') includeShipping?: string) {
        return this.reportsService.getSalesReport(req.store.storeId, from, to, status, includeShipping !== 'false', req.store.permissions.includes('costos.ver'));
    }

    @Get('top-products')
    @RequirePermission('analiticas.ver')
    @ApiOperation({
        summary: 'Productos ganadores del periodo, con su stock y en cuánto tiempo se agotaría',
        description: 'Lo más vendido (unidades e ingresos de los productos, sin envío) y, por producto, el stock en Synkro y los días que durará según el ritmo de venta de los últimos 30 días. No cuentan las ventas canceladas ni devueltas.',
    })
    @ApiQuery({ name: 'from', required: false, example: '2026-07-01' })
    @ApiQuery({ name: 'to', required: false, example: '2026-07-22' })
    @ApiQuery({ name: 'status', required: false })
    @ApiQuery({ name: 'sort', required: false, description: 'units (por defecto), revenue o days (se agota antes).' })
    @ApiQuery({ name: 'limit', required: false })
    getTopProducts(@Req() req, @Query('from') from?: string, @Query('to') to?: string, @Query('status') status?: string, @Query('sort') sort?: string, @Query('limit') limit?: string) {
        return this.reportsService.getTopProducts(req.store.storeId, from, to, status, criterio(sort), Number(limit) || 200);
    }

    @Get('export')
    @RequirePermission('analiticas.ver')
    @ApiOperation({
        summary: 'Descarga el reporte de analíticas en Excel o PDF',
        description: 'Ventas del periodo (por día, canal y cuenta) y productos ganadores con su stock y cuándo se agota. Mismos filtros que la pantalla. format = xlsx o pdf.',
    })
    @ApiQuery({ name: 'format', required: true, description: 'xlsx o pdf' })
    @ApiQuery({ name: 'from', required: false })
    @ApiQuery({ name: 'to', required: false })
    @ApiQuery({ name: 'status', required: false })
    @ApiQuery({ name: 'includeShipping', required: false })
    @ApiQuery({ name: 'sort', required: false })
    async exportar(
        @Req() req,
        @Res() res: Response,
        @Query('format') format?: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('status') status?: string,
        @Query('includeShipping') includeShipping?: string,
        @Query('sort') sort?: string,
    ) {
        if (format !== 'xlsx' && format !== 'pdf') throw new BadRequestException('El formato es xlsx o pdf.');
        const storeId = req.store.storeId;
        const ventas = await this.reportsService.getSalesReport(storeId, from, to, status, includeShipping !== 'false', req.store.permissions.includes('costos.ver'));
        const ganadores = await this.reportsService.getTopProducts(storeId, from, to, status, criterio(sort), 100);
        const fotos = await descargarFotos(ganadores.items.slice(0, format === 'pdf' ? 15 : 30).map((g) => g.imageUrl));
        const datos = {
            tienda: String(req.store.name ?? 'Tienda'),
            generado: new Date(),
            ventas: ventas as any,
            ganadores,
            estados: (status ?? '').split(',').map((e) => e.trim()).filter(Boolean),
        };
        const archivo = format === 'pdf' ? await reporteAPdf(datos, fotos) : await reporteAExcel(datos, fotos);
        res.set({
            'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="analiticas_${ventas.range.from}_${ventas.range.to}.${format}"`,
            'Cache-Control': 'no-store',
        });
        res.end(archivo);
    }
}

const criterio = (v?: string): CriterioDeOrden => (v === 'revenue' || v === 'days' ? v : 'units');
