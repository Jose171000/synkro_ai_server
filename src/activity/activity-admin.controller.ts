import { BadRequestException, Controller, Get, Logger, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
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
import { ActivityReportService, leerOpcionesDeInforme } from './activity-report.service';
import { informeAExcel } from './activity-excel';
import { informeAPdf } from './activity-pdf';

/** Pantallas con mapa de clics que caben en cada formato (el PDF dibuja cada una; el Excel solo las lista). */
const PANTALLAS_EN_PDF = 12;
const PANTALLAS_EN_EXCEL = 40;

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
    private readonly logger = new Logger(ActivityAdminController.name);

    constructor(
        private readonly activity: ActivityService,
        private readonly consultas: ActivityQueriesService,
        private readonly informes: ActivityReportService,
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

    @Get('layout')
    @ApiOperation({ summary: 'Plano de una pantalla (forma de sus bloques, sin texto) sobre el que se dibuja su mapa de clics' })
    @ApiQuery({ name: 'screen', required: true })
    async plano(@Query() q: Record<string, any>) {
        const pantalla = limpiarEtiqueta(q.screen, 60);
        if (!pantalla) throw new BadRequestException('Indica la pantalla (screen).');
        // Siempre un objeto: un cuerpo vacío (pantalla sin plano todavía) haría fallar al navegador al leer la respuesta.
        return { plano: await this.consultas.plano(pantalla) };
    }

    private async descargar(q: Record<string, any>, req: any, res: Response, formato: 'xlsx' | 'pdf') {
        const f = await this.filtro(q);
        const opciones = leerOpcionesDeInforme(q);
        const informe = await this.informes.armar(f, opciones, formato === 'pdf' ? PANTALLAS_EN_PDF : PANTALLAS_EN_EXCEL);
        const archivo = formato === 'pdf' ? await informeAPdf(informe) : await informeAExcel(informe);
        // Quién descargó y con qué alcance (sin datos de las personas).
        this.logger.log(`Descarga ${formato} de actividad por ${req.user?.id}: ${f.desde}..${f.hasta}, ${opciones.completo ? 'completa' : 'personalizada'}`);
        res.set({
            'Content-Type': formato === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="actividad-synkro_${f.desde}_${f.hasta}.${formato}"`,
            'Cache-Control': 'no-store',
        });
        res.end(archivo);
    }

    @Get('export/xlsx')
    @ApiOperation({
        summary: 'Descarga la actividad en Excel (una hoja por bloque)',
        description: 'Mismos filtros que el resto. include = resumen,secciones,funciones,horarios,personas,clics,linea (por defecto todos); screens = pantallas para los clics (por defecto todas).',
    })
    async excel(@Query() q: Record<string, any>, @Req() req, @Res() res: Response) {
        await this.descargar(q, req, res, 'xlsx');
    }

    @Get('export/pdf')
    @ApiOperation({
        summary: 'Descarga la actividad en PDF visual',
        description: 'Mismos parámetros que el Excel. Por defecto lleva todos los datos y avisa que se puede personalizar.',
    })
    async pdf(@Query() q: Record<string, any>, @Req() req, @Res() res: Response) {
        await this.descargar(q, req, res, 'pdf');
    }
}
