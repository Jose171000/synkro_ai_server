import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { AdminService } from './admin.service';
import { UpdateClientProfileDto } from './dto/update-client-profile.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
    constructor(private readonly adminService: AdminService) { }

    @Get('clients')
    @ApiOperation({ summary: 'Lista todos los clientes con sus estadísticas y pagos (solo admin)' })
    getClients() {
        return this.adminService.getClients();
    }

    @Get('clients/:id')
    @ApiOperation({ summary: 'Detalle de un cliente: perfil, pagos y actividad' })
    getClientDetail(@Param('id') id: string) {
        return this.adminService.getClientDetail(id);
    }

    @Patch('clients/:id/profile')
    @ApiOperation({ summary: 'Crea o actualiza el perfil comercial del cliente (RUC, plan, sheet de reportes...)' })
    updateProfile(@Param('id') id: string, @Body() dto: UpdateClientProfileDto) {
        return this.adminService.updateClientProfile(id, dto);
    }

    @Post('clients/:id/payments')
    @ApiOperation({ summary: 'Registra un pago del cliente (único o recurrente)' })
    addPayment(@Param('id') id: string, @Body() dto: CreatePaymentDto) {
        return this.adminService.addPayment(id, dto);
    }

    @Delete('payments/:paymentId')
    @ApiOperation({ summary: 'Elimina un pago registrado por error' })
    removePayment(@Param('paymentId') paymentId: string) {
        return this.adminService.removePayment(paymentId);
    }

    @Get('finance/summary')
    @ApiOperation({ summary: 'Panel financiero: total histórico, ingresos del mes, MRR e ingresos por mes' })
    getFinanceSummary() {
        return this.adminService.getFinanceSummary();
    }
}
