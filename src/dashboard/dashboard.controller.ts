import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
    constructor(private readonly dashboard: DashboardService) { }

    @Get('summary')
    @ApiOperation({
        summary: 'Resumen del negocio de la cuenta',
        description: 'Canales conectados, catálogo, ventas del mes contra el anterior, stock en riesgo y avisos pendientes.',
    })
    getSummary(@Req() req) {
        return this.dashboard.getSummary(req.user.id);
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
