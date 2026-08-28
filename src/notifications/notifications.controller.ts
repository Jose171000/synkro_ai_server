import { Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
    constructor(private readonly notifications: NotificationsService) { }

    @Get()
    @ApiOperation({
        summary: 'Avisos de la cuenta, del más reciente al más antiguo',
        description: 'Devuelve también cuántos quedan sin leer, para el contador de la campana.',
    })
    list(@Req() req, @Query('limit') limit?: string, @Query('unreadOnly') unreadOnly?: string) {
        return this.notifications.list(req.user.id, {
            limit: limit ? Number(limit) : undefined,
            unreadOnly: unreadOnly === 'true',
        });
    }

    @Patch(':id/read')
    @ApiOperation({ summary: 'Marca un aviso como leído' })
    markRead(@Param('id') id: string, @Req() req) {
        return this.notifications.markRead(req.user.id, id);
    }

    @Post('read-all')
    @ApiOperation({ summary: 'Marca todos los avisos como leídos' })
    markAllRead(@Req() req) {
        return this.notifications.markAllRead(req.user.id);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Elimina un aviso' })
    remove(@Param('id') id: string, @Req() req) {
        return this.notifications.remove(req.user.id, id);
    }
}
