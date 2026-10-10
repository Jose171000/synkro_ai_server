import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSection, SectionAccessGuard } from '../common/guards/section-access.guard';
import { RequireStoreRole, StoreAccessGuard } from '../stores/store-access.guard';
import { SyncScope, SyncService } from './sync.service';
import { PublishProductDto } from './dto/publish-product.dto';
import { UpdateInventoryDto } from './dto/update-inventory.dto';
import { ConnectYavendioDto } from './dto/connect-yavendio.dto';
import { ConnectFalabellaDto } from './dto/connect-falabella.dto';
import { PublishFalabellaDto } from './dto/publish-falabella.dto';
import { PrepareFalabellaDto } from './dto/prepare-falabella.dto';
import { RejectChangeDto, ReviewModeDto } from './dto/review-mode.dto';
import { WebPriceDto } from './dto/web-price.dto';
import { ChangeRequestsService } from './change-requests.service';
import { OrdersQueryService } from './orders-query.service';

/** Quién actúa y en qué tienda: la tienda la fija StoreAccessGuard tras comprobar el acceso. */
const scopeOf = (req: any): SyncScope => ({ userId: req.user.id, storeId: req.store.storeId });

/**
 * Todo lo de canales ocurre dentro de una tienda: la tienda activa llega en
 * la cabecera X-Store-Id y se comprueba en cada petición. Los roles se aplican
 * así: lector mira; editor propone cambios de precio y stock; dueño conecta
 * cuentas, publica, importa y aprueba.
 */
@ApiTags('sync')
@Controller('sync')
@RequireSection('marketplaces')
@ApiHeader({ name: 'X-Store-Id', required: false, description: 'Tienda activa. Sin ella se usa la tienda por defecto del usuario.' })
export class SyncController {
    constructor(
        private readonly syncService: SyncService,
        private readonly changeRequests: ChangeRequestsService,
        private readonly ordersQuery: OrdersQueryService,
    ) { }

    // ── Connections ──────────────────────────────────────────────

    @Get('connections')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('viewer')
    @ApiOperation({ summary: 'Cuentas de marketplaces conectadas a la tienda (sin credenciales)' })
    getConnections(@Req() req) {
        return this.syncService.getConnections(scopeOf(req).storeId);
    }

    @Get('mercadolibre/auth-url')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Genera la URL de autorización OAuth de Mercado Libre para esta tienda',
        description: 'El frontend redirige al usuario a esta URL; al autorizar, Mercado Libre llama a /sync/mercadolibre/callback. Una tienda admite hasta 3 cuentas.',
    })
    @ApiQuery({ name: 'label', required: false, description: 'Nombre para distinguir esta cuenta de otras del mismo canal.' })
    getMeliAuthUrl(@Req() req, @Query('label') label?: string) {
        return this.syncService.getMeliAuthUrl(scopeOf(req), label);
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
            return res.redirect(
                `${frontend}/?meli=connected&nickname=${encodeURIComponent(result.nickname)}&store=${encodeURIComponent(result.storeId)}`,
            );
        } catch (error: any) {
            const message = error?.response?.message || error?.message || 'Error al conectar con Mercado Libre';
            return res.redirect(`${frontend}/?meli=error&message=${encodeURIComponent(message)}`);
        }
    }

    @Post('yavendio/connect')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Conecta una cuenta de Yavendió a la tienda con su API key',
        description: 'Valida la clave contra Yavendió antes de guardarla cifrada. La clave nunca se devuelve. Una tienda admite hasta 3 cuentas.',
    })
    connectYavendio(@Body() dto: ConnectYavendioDto, @Req() req) {
        return this.syncService.connectYavendio(scopeOf(req), dto.apiKey, dto.label);
    }

    @Post('falabella/connect')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Conecta una cuenta de Falabella Seller Center a la tienda',
        description: 'Comprueba las credenciales con una consulta real antes de guardarlas. La API key se guarda cifrada y nunca se devuelve. Una tienda admite hasta 3 cuentas.',
    })
    connectFalabella(@Body() dto: ConnectFalabellaDto, @Req() req) {
        return this.syncService.connectFalabella(scopeOf(req), {
            userId: dto.userId,
            apiKey: dto.apiKey,
            country: dto.country,
            label: dto.label,
        });
    }

    @Get('listings')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('viewer')
    @ApiOperation({ summary: 'Publicaciones de la tienda en todas sus cuentas de marketplaces' })
    getListings(@Req() req) {
        return this.syncService.getAllListings(scopeOf(req).storeId);
    }

    @Delete('connections/:connectionId')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({ summary: 'Desconecta una cuenta de marketplace (por su id)' })
    disconnect(@Param('connectionId') connectionId: string, @Req() req) {
        return this.syncService.disconnect(scopeOf(req).storeId, connectionId);
    }

    // ── Publishing & inventory ───────────────────────────────────

    @Post('products/:id/publish')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Publica un producto en los marketplaces indicados (asíncrono)',
        description: 'Encola un job por marketplace. Si la tienda tiene varias cuentas del canal hay que indicar cuál en connectionIds.',
    })
    publish(@Param('id') id: string, @Body() dto: PublishProductDto, @Req() req) {
        return this.syncService.enqueuePublish(scopeOf(req), id, dto.marketplaces, dto.connectionIds);
    }

    @Get('falabella/categories')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Busca categorías de Falabella donde publicar',
        description: 'Solo devuelve categorías finales, con su ruta completa. El árbol se guarda en memoria porque pesa y tarda.',
    })
    searchFalabellaCategories(@Query('search') search: string, @Req() req, @Query('connectionId') connectionId?: string) {
        return this.syncService.searchFalabellaCategories(scopeOf(req), search || '', connectionId);
    }

    @Get('falabella/categories/:categoryId/fields')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Datos obligatorios que pide una categoría de Falabella',
        description: 'Devuelve solo lo que hay que pedirle a la persona: los campos que la plataforma ya envía por su cuenta quedan fuera.',
    })
    getFalabellaCategoryFields(@Param('categoryId') categoryId: string, @Req() req, @Query('connectionId') connectionId?: string) {
        return this.syncService.getFalabellaCategoryFields(scopeOf(req), categoryId, connectionId);
    }

    @Patch('falabella/products/:id/preparation')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Guarda la categoría, medidas y atributos que Falabella exige',
        description: 'Al guardar comprueba con las reglas reales de publicación y responde si el producto ya puede salir o qué le falta.',
    })
    prepareFalabella(@Param('id') id: string, @Body() dto: PrepareFalabellaDto, @Req() req) {
        return this.syncService.prepareFalabellaProduct(scopeOf(req), id, dto);
    }

    @Post('falabella/publish')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Publica varios productos en Falabella en un solo envío',
        description:
            'Falabella limita las llamadas de publicación (50 seguidas y luego 2 minutos entre cada una), ' +
            'así que los productos se agrupan en lotes de 500. Devuelve los que se enviaron y, con su motivo, ' +
            'los que no cumplían los requisitos. El resultado real llega después: Falabella procesa en diferido.',
    })
    publishFalabella(@Body() dto: PublishFalabellaDto, @Req() req) {
        return this.syncService.publishBatchToFalabella(scopeOf(req), dto.connectionId, dto.productIds);
    }

    @Patch('products/:id/inventory')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('editor')
    @ApiOperation({
        summary: 'Actualiza stock/precio y lo sincroniza con los canales publicados',
        description: 'Con el modo revisión de la tienda encendido (por defecto) no toca los canales: crea solicitudes pendientes y responde 202.',
    })
    async updateInventory(
        @Param('id') id: string,
        @Body() dto: UpdateInventoryDto,
        @Req() req,
        @Res({ passthrough: true }) res: Response,
    ) {
        const result = await this.syncService.updateInventory(scopeOf(req), id, dto);
        if ('pending' in result) res.status(HttpStatus.ACCEPTED);
        return result;
    }

    @Patch('products/:id/web-price')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('editor')
    @ApiOperation({
        summary: 'Fija el precio con descuento de la tienda web',
        description: 'No se envía a ningún marketplace ni pasa por revisión; se usará cuando exista la conexión con WooCommerce.',
    })
    setWebPrice(@Param('id') id: string, @Body() dto: WebPriceDto, @Req() req) {
        return this.syncService.setWebPrice(scopeOf(req), id, dto.webPrice);
    }

    // ── Modo revisión: cola de aprobación ────────────────────────

    @Get('change-requests')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('viewer')
    @ApiOperation({ summary: 'Solicitudes de cambio de precio/stock de la tienda' })
    @ApiQuery({ name: 'status', required: false, enum: ['pending', 'approved', 'rejected', 'sent', 'error'] })
    listChangeRequests(@Req() req, @Query('status') status?: string) {
        return this.changeRequests.list(scopeOf(req), status);
    }

    @Post('change-requests/:id/approve')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({ summary: 'Aprueba un cambio: lo aplica al producto y lo envía al canal (asíncrono)' })
    approveChangeRequest(@Param('id') id: string, @Req() req) {
        return this.changeRequests.approve(id, scopeOf(req));
    }

    @Post('change-requests/:id/reject')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({ summary: 'Rechaza un cambio: no toca el producto ni el canal' })
    rejectChangeRequest(@Param('id') id: string, @Body() dto: RejectChangeDto, @Req() req) {
        return this.changeRequests.reject(id, scopeOf(req), dto.reason);
    }

    @Get('settings')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('viewer')
    @ApiOperation({ summary: 'Ajustes de sincronización de la tienda' })
    async getSyncSettings(@Req() req) {
        return { reviewMode: await this.changeRequests.isReviewMode(scopeOf(req).storeId) };
    }

    @Patch('settings/review-mode')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({ summary: 'Enciende o apaga el modo revisión de la tienda' })
    setReviewMode(@Body() dto: ReviewModeDto, @Req() req) {
        return this.changeRequests.setReviewMode(scopeOf(req).storeId, dto.enabled);
    }

    @Get('products/:id/status')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('viewer')
    @ApiOperation({ summary: 'Estado de sincronización del producto en cada cuenta de marketplace' })
    getStatus(@Param('id') id: string, @Req() req) {
        return this.syncService.getProductSyncStatus(scopeOf(req), id);
    }

    @Post('falabella/webhook/register')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Pide a Falabella que avise de cada venta',
        description:
            'Registra un webhook propio con una dirección única para esta cuenta. Se añade a los que ya existan: ' +
            'si la cuenta tiene otro sistema conectado, sigue recibiendo sus avisos.',
    })
    registerFalabellaWebhook(@Req() req, @Query('connectionId') connectionId?: string) {
        return this.syncService.registerFalabellaWebhook(scopeOf(req), connectionId);
    }

    @Post('falabella/listings/import')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Trae de un clic las publicaciones que ya existen en una cuenta de Falabella',
        description:
            'Lee el catálogo completo de la cuenta y lo enlaza con el catálogo de la tienda. ' +
            'Con dryRun=true no escribe nada: solo informa de qué pasaría, para poder ' +
            'enseñar la previsualización antes de crear productos.',
    })
    @ApiQuery({
        name: 'dryRun',
        required: false,
        type: Boolean,
        description: 'true para previsualizar sin guardar nada.',
    })
    @ApiQuery({ name: 'connectionId', required: false, description: 'Cuenta de Falabella; obligatoria si la tienda tiene varias.' })
    importFalabellaListings(@Req() req, @Query('dryRun') dryRun?: string, @Query('connectionId') connectionId?: string) {
        return this.syncService.importFalabellaListings(scopeOf(req), connectionId, {
            dryRun: dryRun === 'true',
        });
    }

    @Post('falabella/orders/sync')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Trae los pedidos recientes de Falabella',
        description: 'Sirve para ponerse al día si algún aviso se perdió. No duplica los ya registrados.',
    })
    syncFalabellaOrders(@Req() req, @Query('connectionId') connectionId?: string) {
        const scope = scopeOf(req);
        return this.syncService.processFalabellaOrders({ userId: scope.userId, storeId: scope.storeId, connectionId });
    }

    @Get('orders')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('viewer')
    @ApiOperation({
        summary: 'Ventas de la tienda, con cliente, envío, precio pagado y stock',
        description:
            'Cada venta con sus líneas: SKU, nombre, precio pagado, stock después de la venta, stock actual y foto. ' +
            'Quien solo tiene lectura no ve los datos de contacto del comprador.',
    })
    @ApiQuery({ name: 'from', required: false, example: '2026-10-01' })
    @ApiQuery({ name: 'to', required: false, example: '2026-10-31' })
    @ApiQuery({ name: 'marketplace', required: false })
    @ApiQuery({ name: 'connectionId', required: false })
    @ApiQuery({ name: 'search', required: false, description: 'Cliente, número de pedido, SKU o nombre.' })
    @ApiQuery({ name: 'limit', required: false })
    @ApiQuery({ name: 'offset', required: false })
    listOrders(
        @Req() req,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('marketplace') marketplace?: string,
        @Query('connectionId') connectionId?: string,
        @Query('search') search?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ) {
        return this.ordersQuery.list(scopeOf(req).storeId, req.store.role, {
            from, to, marketplace, connectionId, search,
            limit: limit ? Number(limit) : undefined,
            offset: offset ? Number(offset) : undefined,
        });
    }

    @Get('orders/:id')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('viewer')
    @ApiOperation({ summary: 'Detalle de una venta: cliente, envío, pago y líneas' })
    getOrder(@Param('id') id: string, @Req() req) {
        return this.ordersQuery.detail(scopeOf(req).storeId, req.store.role, id);
    }

    @Post('orders/sync')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Actualiza las ventas de todas las cuentas de la tienda ahora',
        description:
            'Trae las ventas de las últimas 48 horas de cada cuenta de Falabella y Mercado Libre, ' +
            'registra las nuevas y descuenta el stock. No duplica las ya registradas. ' +
            'Cada cuenta responde por separado: si una falla, las demás se revisan igual.',
    })
    syncStoreOrders(@Req() req) {
        return this.syncService.syncStoreOrders(scopeOf(req).storeId);
    }

    // ── Webhooks ─────────────────────────────────────────────────

    // Public: Mercado Libre POSTs notifications here (configure the URL in DevCenter).
    // Must answer 200 fast; heavy work is deferred to the queue.
    // Público: Falabella llama aquí cuando hay una venta. La identidad va en
    // el testigo de la URL, porque Falabella no firma sus llamadas.
    @Post('webhooks/falabella/:token')
    @HttpCode(HttpStatus.OK)
    @ApiExcludeEndpoint()
    handleFalabellaWebhook(@Param('token') token: string, @Body() body: any) {
        return this.syncService.handleFalabellaNotification(token, body);
    }

    @Post('webhooks/mercadolibre')
    @HttpCode(HttpStatus.OK)
    @ApiExcludeEndpoint()
    handleMeliWebhook(@Body() body: any) {
        return this.syncService.handleMeliNotification(body);
    }
}
