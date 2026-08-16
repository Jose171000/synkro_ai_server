import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
    constructor(private readonly reportsService: ReportsService) { }

    @Get('config')
    @ApiOperation({
        summary: 'Reporte externo configurado para el usuario autenticado',
        description: 'Devuelve la URL a embeber (AppScript, Looker Studio) si el administrador configuró una.',
    })
    getConfig(@Req() req) {
        return this.reportsService.getReportConfig(req.user.id);
    }

    @Get('sales')
    @ApiOperation({
        summary: 'Reporte de ventas del usuario autenticado',
        description: 'Combina las órdenes reales de marketplaces con el Google Sheet vinculado (si existe). Rango por defecto: últimos 30 días.',
    })
    @ApiQuery({ name: 'from', required: false, example: '2026-07-01' })
    @ApiQuery({ name: 'to', required: false, example: '2026-07-22' })
    getSales(@Req() req, @Query('from') from?: string, @Query('to') to?: string) {
        return this.reportsService.getSalesReport(req.user.id, from, to);
    }
}
