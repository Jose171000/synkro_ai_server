import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ActivityService } from './activity.service';
import { PrivacyService } from './privacy.service';

/**
 * Lo que usan los navegadores de TODOS los usuarios: mandar su actividad y aceptar el aviso de privacidad. No devuelve
 * nunca la actividad de nadie (eso es solo de superadmin, en `admin/activity`).
 */
@ApiTags('activity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('activity')
export class ActivityController {
    constructor(
        private readonly activity: ActivityService,
        private readonly privacy: PrivacyService,
    ) { }

    @Get('consent')
    @ApiOperation({ summary: 'Versión vigente del aviso de privacidad y si esta persona ya la aceptó' })
    consentimiento(@Req() req) {
        return this.privacy.estado(req.user.id);
    }

    @Post('consent')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Acepta el aviso de privacidad vigente (desde la ventana que se muestra a quien ya tenía cuenta)' })
    async aceptar(@Req() req) {
        await this.privacy.aceptar(req.user.id, 'aviso');
        return this.privacy.estado(req.user.id);
    }

    // El navegador manda un lote cada pocos segundos: se permite de sobra, pero no un chorro.
    @Throttle({ short: { limit: 5, ttl: 1000 }, medium: { limit: 60, ttl: 60_000 } })
    @Post('events')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Recibe un lote de actividad del navegador (vistas, clics y latidos)',
        description:
            'Body: { sessionId (uuid), storeId?, device?, events: [{ t: view|click|ping, screen, element?, x?, y?, ex?, ey?, ew?, eh?, v?, at? }] }. ' +
            'Máximo 100 eventos. Sin aceptar el aviso de privacidad no se guarda nada y la respuesta trae requiereAviso = true.',
    })
    eventos(@Req() req, @Body() body: any) {
        return this.activity.registrarLote({ id: req.user.id, role: req.user.role }, body);
    }

    // Una pantalla se manda una vez por visita; de sobra, pero sin chorros.
    @Throttle({ short: { limit: 3, ttl: 1000 }, medium: { limit: 30, ttl: 60_000 } })
    @Post('layout')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Recibe el plano de una pantalla (forma de sus bloques, sin ningún texto) para dibujar los mapas de clics',
        description: 'Body: { screen, width, height, blocks: [{ k: titulo|tabla|pestanas|grafico|imagen|campo|boton|tarjeta, x, y, w, h }] } en milésimas. Sin aceptar el aviso de privacidad no se guarda nada.',
    })
    plano(@Req() req, @Body() body: any) {
        return this.activity.guardarPlano({ id: req.user.id }, body);
    }
}
