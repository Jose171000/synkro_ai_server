import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ReportsService } from './reports.service';
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
        return this.reportsService.getSalesReport(req.store.storeId, from, to, status, includeShipping !== 'false');
    }
}
