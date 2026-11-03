import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { ActivityService } from './activity.service';
import { ActivityQueriesService } from './activity-queries.service';
import { leerFiltro } from './activity-filter';
import { limpiarEtiqueta } from './activity-validation';
import { ZONA_HORARIA } from './activity.constants';

const hoyEnLima = () => new Date().toLocaleDateString('en-CA', { timeZone: ZONA_HORARIA });

/**
 * Actividad de los usuarios. SOLO superadmin (rol admin): nadie más la ve, ni siquiera el contador. Todas las consultas
 * aceptan los mismos filtros: from, to (AAAA-MM-DD, día de Lima), userId, platformRoles, storeRoles (separados por coma) y
 * mode (average | total).
 */
@ApiTags('admin-activity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/activity')
export class ActivityAdminController {
    constructor(
        private readonly activity: ActivityService,
        private readonly consultas: ActivityQueriesService,
    ) { }

    private async filtro(q: Record<string, any>) {
        await this.activity.refrescarSiHaceFalta();
        return leerFiltro(q, hoyEnLima());
    }

    @Get('options')
    @ApiOperation({ summary: 'Roles disponibles y personas con actividad, para los selectores' })
    opciones() {
        return this.consultas.opciones();
    }

    @Get('overview')
    @ApiOperation({
        summary: 'Resumen de la actividad: indicadores, secciones y funciones más usadas, horarios y, si se elige una persona, su línea de tiempo',
    })
    @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false }) @ApiQuery({ name: 'userId', required: false })
    @ApiQuery({ name: 'platformRoles', required: false, description: 'admin, contador, moderator, user (varios, separados por coma)' })
    @ApiQuery({ name: 'storeRoles', required: false, description: 'owner, editor, viewer (varios, separados por coma)' })
    @ApiQuery({ name: 'mode', required: false, enum: ['average', 'total'] })
    async resumen(@Query() q: Record<string, any>) {
        const f = await this.filtro(q);
        const [resumen, secciones, funciones, horas, linea] = await Promise.all([
            this.consultas.resumen(f),
            this.consultas.secciones(f),
            this.consultas.funciones(f),
            this.consultas.horas(f),
            f.userId ? this.consultas.linea(f.userId, f) : Promise.resolve(null),
        ]);
        return { filtro: f, resumen, secciones, funciones, horas, linea };
    }

    @Get('people')
    @ApiOperation({ summary: 'Resumen por persona con los filtros puestos, de la más activa a la menos activa' })
    async personas(@Query() q: Record<string, any>) {
        return this.consultas.personas(await this.filtro(q));
    }

    @Get('screens')
    @ApiOperation({ summary: 'Pantallas donde hubo clics (las que tienen mapa de calor)' })
    async pantallas(@Query() q: Record<string, any>) {
        return this.consultas.pantallas(await this.filtro(q));
    }

    @Get('clicks')
    @ApiOperation({
        summary: 'Mapa de clics de una pantalla: cada elemento con sus clics, personas, participación, intensidad y posición en la pantalla',
        description: 'Con todos los usuarios y mode=average, el mapa de cada persona se normaliza y luego se promedia: cada persona pesa lo mismo.',
    })
    @ApiQuery({ name: 'screen', required: true })
    async clics(@Query() q: Record<string, any>) {
        const pantalla = limpiarEtiqueta(q.screen, 60);
        if (!pantalla) throw new BadRequestException('Indica la pantalla (screen).');
        return this.consultas.clics(await this.filtro(q), pantalla);
    }
}
