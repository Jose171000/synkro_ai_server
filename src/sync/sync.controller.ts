import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSection, SectionAccessGuard } from '../common/guards/section-access.guard';
import { SyncService } from './sync.service';
import { PublishProductDto } from './dto/publish-product.dto';
import { UpdateInventoryDto } from './dto/update-inventory.dto';

@ApiTags('sync')
@Controller('sync')
@RequireSection('marketplaces')
export class SyncController {
    constructor(private readonly syncService: SyncService) { }

    // ── Connections ──────────────────────────────────────────────

    @Get('connections')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard)
    @ApiOperation({ summary: 'Lista las cuentas de marketplaces conectadas del usuario' })
    getConnections(@Req() req) {
        return this.syncService.getConnections(req.user.id);
    }

    @Get('mercadolibre/auth-url')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard)
    @ApiOperation({
        summary: 'Genera la URL de autorización OAuth de Mercado Libre',
        description: 'El frontend redirige al usuario a esta URL; al autorizar, Mercado Libre llama a /sync/mercadolibre/callback.',
    })
    getMeliAuthUrl(@Req() req) {
        return this.syncService.getMeliAuthUrl(req.user.id);
    }

    // Public: Mercado Libre redirects the seller's browser here after authorizing.
    // Identity is resolved via the `state` stored in Redis, not via JWT.
    // Redirects back to the frontend so the user lands on the dashboard.
    @Get('mercadolibre/callback')
    @ApiOperation({ summary: 'Callback OAuth de Mercado Libre (público, redirige al frontend)' })
    async handleMeliCallback(
        @Query('code') code: string,
        @Query('state') state: string,
        @Res() res: Response,
    ) {
        const frontend = process.env.FRONTEND_URL || 'http://localhost:8080';
        try {
            const result = await this.syncService.handleMeliCallback(code, state);
            return res.redirect(`${frontend}/?meli=connected&nickname=${encodeURIComponent(result.nickname)}`);
        } catch (error: any) {
            const message = error?.response?.message || error?.message || 'Error al conectar con Mercado Libre';
            return res.redirect(`${frontend}/?meli=error&message=${encodeURIComponent(message)}`);
        }
    }

    @Get('listings')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard)
    @ApiOperation({ summary: 'Lista todas las publicaciones del usuario en los marketplaces' })
    getListings(@Req() req) {
        return this.syncService.getAllListings(req.user.id);
    }

    @Delete('connections/:marketplace')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard)
    @ApiOperation({ summary: 'Desconecta una cuenta de marketplace' })
    disconnect(@Param('marketplace') marketplace: string, @Req() req) {
        return this.syncService.disconnect(req.user.id, marketplace);
    }

    // ── Publishing & inventory ───────────────────────────────────

    @Post('products/:id/publish')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard)
    @ApiOperation({
        summary: 'Publica un producto en los marketplaces indicados (asíncrono)',
        description: 'Encola un job por marketplace. Requiere cuenta conectada, precio definido y categoría generada por la IA.',
    })
    publish(@Param('id') id: string, @Body() dto: PublishProductDto, @Req() req) {
        return this.syncService.enqueuePublish(id, req.user.id, dto.marketplaces);
    }

    @Patch('products/:id/inventory')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard)
    @ApiOperation({
        summary: 'Actualiza stock/precio local y lo sincroniza con todos los canales publicados',
    })
    updateInventory(@Param('id') id: string, @Body() dto: UpdateInventoryDto, @Req() req) {
        return this.syncService.updateInventory(id, req.user.id, dto);
    }

    @Get('products/:id/status')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard)
    @ApiOperation({ summary: 'Estado de sincronización del producto en cada marketplace' })
    getStatus(@Param('id') id: string, @Req() req) {
        return this.syncService.getProductSyncStatus(id, req.user.id);
    }

    // ── Webhooks ─────────────────────────────────────────────────

    // Public: Mercado Libre POSTs notifications here (configure the URL in DevCenter).
    // Must answer 200 fast; heavy work is deferred to the queue.
    @Post('webhooks/mercadolibre')
    @HttpCode(HttpStatus.OK)
    @ApiExcludeEndpoint()
    handleMeliWebhook(@Body() body: any) {
        return this.syncService.handleMeliNotification(body);
    }
}
