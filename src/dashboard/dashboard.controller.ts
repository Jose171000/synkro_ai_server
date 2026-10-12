import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { DashboardService } from './dashboard.service';
import { DashboardInsightsService } from './dashboard-insights.service';
import { UpdateStorePlanDto } from './dto/update-store-plan.dto';
import { CreatePaymentDto } from '../admin/dto/create-payment.dto';
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
        return this.insights.getInsights({
            userId: req.user.id,
            storeId: req.store.storeId,
            verPlan: req.store.role === 'owner' || req.user.role === UserRole.ADMIN,
        });
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

    @Get('agency/stores/:id')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @ApiOperation({
        summary: 'El dashboard de una tienda (cliente), como lo ve su dueño',
        description: 'Resumen del negocio, productos ganadores, despachos, ventas recientes, su plan y sus últimos pagos, para revisarlo a detalle.',
    })
    getClientDetail(@Param('id', ParseUUIDPipe) id: string) {
        return this.insights.getClientDetail(id);
    }

    @Patch('agency/stores/:id/plan')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @ApiOperation({
        summary: 'Guarda el plan comercial de una tienda',
        description: 'Cuota fija, comisión, IGV incluido o aparte, frecuencia y fecha del próximo cobro. Cada tienda es un cliente de la agencia.',
    })
    updateStorePlan(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStorePlanDto) {
        return this.insights.updateStorePlan(id, dto);
    }

    @Post('agency/stores/:id/payments')
    @UseGuards(RolesGuard)
    @Roles(UserRole.ADMIN)
    @ApiOperation({
        summary: 'Registra un pago recibido de una tienda',
        description: 'Si es recurrente, la fecha del próximo cobro avanza sola un periodo.',
    })
    registerStorePayment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePaymentDto) {
        return this.insights.registerStorePayment(id, dto);
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
