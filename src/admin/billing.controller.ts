import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { BillingService } from './billing.service';
import { UpsertBillingDto, UpdateBillingStatusDto } from './dto/billing.dto';

/**
 * Facturación por comisión. Accesible para el administrador y para el
 * contador, que necesita ver a quién emitir factura sin tener acceso al
 * resto de la operación.
 */
@ApiTags('billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.ACCOUNTANT)
@Controller('admin/billing')
export class BillingController {
    constructor(private readonly billingService: BillingService) { }

    @Get()
    @ApiOperation({
        summary: 'Liquidaciones del periodo con todos los clientes',
        description: 'Incluye los clientes que aún no tienen liquidación cargada, para saber a quién falta.',
    })
    @ApiQuery({ name: 'period', required: true, example: '2026-08' })
    getPeriod(@Query('period') period: string) {
        const target = period || new Date().toISOString().slice(0, 7);
        return this.billingService.getPeriod(target);
    }

    @Get('trend')
    @ApiOperation({ summary: 'Comisiones y ventas por mes (últimos 12 periodos)' })
    getTrend() {
        return this.billingService.getTrend();
    }

    @Get('fetch-sales')
    @ApiOperation({
        summary: 'Consulta las ventas reales del cliente en el periodo',
        description: 'Suma la hoja de cálculo vinculada (AppScript) y los marketplaces sincronizados para prellenar el monto.',
    })
    @ApiQuery({ name: 'clientId', required: true })
    @ApiQuery({ name: 'period', required: true, example: '2026-08' })
    fetchSales(@Query('clientId') clientId: string, @Query('period') period: string) {
        return this.billingService.fetchSales(clientId, period);
    }

    @Get('client/:clientId')
    @ApiOperation({ summary: 'Histórico de liquidaciones de un cliente' })
    getClientHistory(@Param('clientId') clientId: string) {
        return this.billingService.getClientHistory(clientId);
    }

    @Post()
    @ApiOperation({ summary: 'Crea o actualiza la liquidación de un cliente en un periodo' })
    upsert(@Body() dto: UpsertBillingDto) {
        return this.billingService.upsert(dto);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Actualiza el estado de facturación y el número de comprobante' })
    updateStatus(@Param('id') id: string, @Body() dto: UpdateBillingStatusDto) {
        return this.billingService.updateStatus(id, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Elimina una liquidación cargada por error' })
    @Roles(UserRole.ADMIN)
    remove(@Param('id') id: string) {
        return this.billingService.remove(id);
    }
}
