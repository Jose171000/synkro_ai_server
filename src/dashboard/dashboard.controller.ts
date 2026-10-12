import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { DashboardService } from './dashboard.service';
import { DashboardInsightsService } from './dashboard-insights.service';
import { RequireStoreRole, StoreAccessGuard } from '../stores/store-access.guard';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
    constructor(
        private readonly dashboard: DashboardService,
        private readonly insights: DashboardInsightsService,
    ) { }

    @Get('summary')
    @UseGuards(StoreAccessGuard)
    @RequireStoreRole('viewer')
    @ApiOperation({
        summary: 'Resumen del negocio de la tienda activa',
        description: 'Canales conectados, catálogo, ventas del mes contra el anterior y stock en riesgo de la tienda indicada en X-Store-Id; y los avisos pendientes de la persona.',
    })
    getSummary(@Req() req) {
        return this.dashboard.getSummary({ userId: req.user.id, storeId: req.store.storeId });
    }

    @Get('insights')
    @UseGuards(StoreAccessGuard)
    @RequireStoreRole('viewer')
    @ApiOperation({
        summary: 'Lo que ayuda en el día a día a quien tiene una tienda',
        description: 'Productos ganadores con sus días de stock, ventas por despachar, ventas de los últimos 14 días, cambios pendientes de revisión y, si la agencia le definió un plan, su próximo pago y lo que lleva de comisión este mes.',
    })
    getInsights(@Req() req) {
        return this.insights.getInsights({ userId: req.user.id, storeId: req.store.storeId });
    }

    @Get('agency')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @ApiOperation({
        summary: 'Control de la cartera para superadmins',
        description: 'Por cliente: ventas del mes y de los 3 anteriores, plan comercial, próximo pago, comisión acumulada, último pago y una propuesta con su borrador de mensaje. Más totales: ingreso fijo mensual, comisión acumulada y proyectada, cobros vencidos y próximos.',
    })
    getAgency() {
        return this.insights.getAgency();
    }

    @Get('agency/clients/:id')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @ApiOperation({
        summary: 'El dashboard de un cliente, como lo ve él',
        description: 'Resumen del negocio, productos ganadores, despachos, ventas recientes y su plan, para revisarlo a detalle. Si el cliente tiene varias tiendas se elige una con storeId.',
    })
    getClientDetail(@Param('id', ParseUUIDPipe) id: string, @Query('storeId') storeId?: string) {
        return this.insights.getClientDetail(id, storeId);
    }

    @Get('agency/stores')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @ApiOperation({
        summary: 'Todas las tiendas y a qué cliente pertenece cada una',
        description: 'Con su dueño, cuánto vendió este mes y cuántos canales tiene. Una tienda se asigna a un cliente a mano, o se reconoce por su dueño o por el nombre de su negocio.',
    })
    getStoreAssignments() {
        return this.insights.getStoreAssignments();
    }

    @Patch('agency/stores/:id/client')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @ApiOperation({
        summary: 'Asigna una tienda a un cliente (clientId null la deja sin asignar)',
        description: 'Cuenta, ventas y comisión de esa tienda pasan a ser del cliente, sin importar a nombre de quién esté la tienda o las cuentas conectadas.',
    })
    assignStore(@Param('id', ParseUUIDPipe) id: string, @Body() body: { clientId: string | null }) {
        return this.insights.assignStore(id, body?.clientId ?? null);
    }

    @Get('accounts')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @ApiOperation({
        summary: 'Panel de agencia: una fila por cliente',
        description: 'Ordenado por quién necesita atención primero: conexiones caídas, luego publicaciones con error.',
    })
    getAccounts() {
        return this.dashboard.getAccounts();
    }
}
