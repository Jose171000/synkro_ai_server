import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { SECTION_DEFINITIONS } from '../common/app-sections';
import { AdminService } from './admin.service';
import { ReportsService } from '../reports/reports.service';
import { UpdateClientProfileDto } from './dto/update-client-profile.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateAccessDto, ResetClientPasswordDto } from './dto/update-access.dto';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
    constructor(
        private readonly adminService: AdminService,
        private readonly reportsService: ReportsService,
    ) { }

    @Get('sections')
    @ApiOperation({
        summary: 'Secciones sobre las que se puede dar o quitar acceso',
        description:
            'La lista vive solo en el servidor. Cualquier módulo nuevo aparece aquí automáticamente, ' +
            'así que la pantalla de permisos nunca se queda desactualizada.',
    })
    getSections() {
        return SECTION_DEFINITIONS;
    }

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

    @Post('clients/:id/reset-password')
    @ApiOperation({
        summary: 'Asigna una contraseña nueva al cliente',
        description: 'Si no envías newPassword, el sistema genera una y te la devuelve para que se la compartas. Cierra sus sesiones abiertas.',
    })
    resetClientPassword(@Param('id') id: string, @Body() dto: ResetClientPasswordDto) {
        return this.adminService.resetClientPassword(id, dto.newPassword);
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

    @Get('embed-check')
    @ApiOperation({
        summary: 'Comprueba si una URL puede mostrarse embebida',
        description: 'Avisa antes de guardarla si el sitio bloquea los iframes (típico en Google Apps Script sin ALLOWALL).',
    })
    checkEmbeddable(@Query('url') url: string) {
        return this.reportsService.checkEmbeddable(url);
    }

    @Get('finance/summary')
    // El contador necesita ver los ingresos, aunque no gestione cuentas
    @Roles(UserRole.ADMIN, UserRole.ACCOUNTANT)
    @ApiOperation({ summary: 'Panel financiero: total histórico, ingresos del mes, MRR e ingresos por mes' })
    getFinanceSummary() {
        return this.adminService.getFinanceSummary();
    }
}
