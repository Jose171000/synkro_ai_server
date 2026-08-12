import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { AdminService } from './admin.service';
import { UpdateClientProfileDto } from './dto/update-client-profile.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateAccessDto } from './dto/update-access.dto';

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

    @Post('clients')
    @ApiOperation({
        summary: 'Crea una cuenta de cliente/usuario con acceso limitado',
        description: 'El superadmin define la contraseña inicial y las secciones visibles. Sin secciones = acceso completo.',
    })
    createClient(@Body() dto: CreateClientDto) {
        return this.adminService.createClient(dto);
    }

    @Get('clients/:id')
    @ApiOperation({ summary: 'Detalle de un cliente: perfil, pagos y actividad' })
    getClientDetail(@Param('id') id: string) {
        return this.adminService.getClientDetail(id);
    }

    @Patch('clients/:id/access')
    @ApiOperation({ summary: 'Define a qué secciones accede el usuario y si su cuenta está activa' })
    updateAccess(@Param('id') id: string, @Body() dto: UpdateAccessDto) {
        return this.adminService.updateAccess(id, dto);
    }

    @Delete('clients/:id')
    @ApiOperation({
        summary: 'Elimina una cuenta y todos sus datos',
        description: 'Borra productos, publicaciones, conexiones, pagos y perfil. No permite borrarse a uno mismo ni al último administrador.',
    })
    deleteClient(@Param('id') id: string, @Req() req) {
        return this.adminService.deleteClient(id, req.user.id);
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
