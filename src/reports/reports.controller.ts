import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ReportsService } from './reports.service';
import { RequireStoreRole, StoreAccessGuard } from '../stores/store-access.guard';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, StoreAccessGuard)
@RequireStoreRole('viewer')
@Controller('reports')
export class ReportsController {
    constructor(private readonly reportsService: ReportsService) { }

    @Get('config')
    @ApiOperation({
        summary: 'Reporte externo configurado para la tienda activa',
        description: 'Devuelve la URL a embeber (AppScript, Looker Studio) si el administrador configuró una.',
    })
    getConfig(@Req() req) {
        return this.reportsService.getReportConfig(req.store.storeId);
    }

    @Get('sales')
    @ApiOperation({
        summary: 'Reporte de ventas de la tienda activa',
        description: 'Las ventas de las cuentas de la tienda (X-Store-Id), por día, canal y cuenta; en la tienda original del dueño se suma además el Google Sheet vinculado. Rango por defecto: últimos 30 días.',
    })
    @ApiQuery({ name: 'from', required: false, example: '2026-07-01' })
    @ApiQuery({ name: 'to', required: false, example: '2026-07-22' })
    getSales(@Req() req, @Query('from') from?: string, @Query('to') to?: string) {
        return this.reportsService.getSalesReport(req.store.storeId, from, to);
    }
}
