import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSection, SectionAccessGuard } from '../common/guards/section-access.guard';
import { RequirePermission, StoreAccessGuard } from '../stores/store-access.guard';
import { SyncScope, SyncService } from './sync.service';
import { PublishProductDto } from './dto/publish-product.dto';
import { UpdateInventoryDto } from './dto/update-inventory.dto';
import { ConnectYavendioDto } from './dto/connect-yavendio.dto';
import { ConnectFalabellaDto } from './dto/connect-falabella.dto';
import { ConnectWooCommerceDto } from './dto/connect-woocommerce.dto';
import { ConnectShopifyDto } from './dto/connect-shopify.dto';
import { ConnectRipleyDto } from './dto/connect-ripley.dto';
import { EcommerceSyncService } from './channels/ecommerce-sync.service';
import { ECOMMERCE_CHANNELS, EcommerceChannel } from './channels/channel-types';
import { PublishFalabellaDto } from './dto/publish-falabella.dto';
import { SetBrandDto } from './dto/set-brand.dto';
import { LinkMeliListingDto } from './dto/link-meli-listing.dto';
import { SaveSheetDto } from './dto/save-sheet.dto';
import { ProductSheetService } from './product-sheet.service';
import { PrepareFalabellaDto } from './dto/prepare-falabella.dto';
import { RejectChangeDto, ReviewModeDto } from './dto/review-mode.dto';
import { WebPriceDto } from './dto/web-price.dto';
import { PromoDto } from './dto/promo.dto';
import { ChannelActionDto } from './dto/channel-action.dto';
import { ListingActionsService } from './listing-actions.service';
import { DuplicatesActionDto } from './dto/duplicates-action.dto';
import { FalabellaVariantImportService } from './falabella-variant-import.service';
import { ManualVariantGroupDto } from './dto/manual-variant-group.dto';
import { ImportFalabellaDto } from './dto/import-falabella.dto';
import { SugerirColoresDto } from './dto/sugerir-colores.dto';
import { ResendStockMasivoDto } from './dto/resend-stock-masivo.dto';
import { ListingPromoDto } from './dto/listing-promo.dto';
import { ChangeRequestIdsDto } from './dto/change-request-ids.dto';
import { GroupPriceDto } from './dto/group-price.dto';
import { ChangeRequestsService } from './change-requests.service';
import { OrdersQueryService } from './orders-query.service';
import { ManualSalesService } from './manual-sales.service';
import { plantillaDeVentas, ventasDeFilas } from './ventas-manuales';
import { escribirHoja } from '../common/excel/excel';
import { YavendioCatalogImportService } from './yavendio/yavendio-catalog-import.service';
import { YavendioOrdersService } from './yavendio/yavendio-orders.service';
import { RipleyMarcasService } from './ripley/ripley-marcas.service';
import { RipleyCatalogoService } from './ripley/ripley-catalogo.service';
import { RipleyPublicacionService } from './ripley/ripley-publicacion.service';
import { PublishRipleyDto } from './dto/publish-ripley.dto';
import { SaveRipleyPreparationDto } from './dto/save-ripley-preparation.dto';
import { ImportarPedidosYavendioDto, VincularYavendioDto } from './dto/yavendio-import.dto';
import { VerifyChannelsDto } from './dto/verify-channels.dto';
import { MarkImportedDto } from './dto/mark-imported.dto';

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
        private readonly manualSales: ManualSalesService,
        private readonly ecommerce: EcommerceSyncService,
        private readonly sheets: ProductSheetService,
        private readonly listingActions: ListingActionsService,
        private readonly variantImport: FalabellaVariantImportService,
        private readonly yavendioCatalog: YavendioCatalogImportService,
        private readonly yavendioOrders: YavendioOrdersService,
        private readonly ripleyMarcas: RipleyMarcasService,
        private readonly ripleyCatalogo: RipleyCatalogoService,
        private readonly ripleyPublicacion: RipleyPublicacionService,
    ) { }

    // ── Connections ──────────────────────────────────────────────

    @Get('connections')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.ver')
    @ApiOperation({ summary: 'Cuentas de marketplaces conectadas a la tienda (sin credenciales)' })
    getConnections(@Req() req) {
        return this.syncService.getConnections(scopeOf(req).storeId);
    }

    @Get('mercadolibre/auth-url')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
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
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Conecta una cuenta de Yavendió a la tienda con su API key',
        description: 'Valida la clave contra Yavendió antes de guardarla cifrada. La clave nunca se devuelve. Una tienda admite hasta 3 cuentas.',
    })
    connectYavendio(@Body() dto: ConnectYavendioDto, @Req() req) {
        return this.syncService.connectYavendio(scopeOf(req), dto.apiKey, dto.label);
    }

    @Get('yavendio/import/products')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Lista lo que hay en Yavendió y con qué producto de Synkro parece corresponder cada variante',
        description: 'Solo lee. Yavendió no usa SKU: se propone por SKU si lo tiene y si no por nombre. Nada se vincula hasta confirmarlo.',
    })
    @ApiQuery({ name: 'connectionId', required: false })
    previewYavendioProducts(@Req() req, @Query('connectionId') connectionId?: string) {
        return this.yavendioCatalog.preview(scopeOf(req), connectionId);
    }

    @Post('yavendio/import/products/link')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Vincula variantes de Yavendió con productos de Synkro (los pares que la persona confirmó)',
        description: 'No escribe nada en Yavendió. El stock queda sin definir y el precio y la disponibilidad solo cambian en el siguiente envío normal.',
    })
    linkYavendioProducts(@Body() dto: VincularYavendioDto, @Req() req) {
        return this.yavendioCatalog.link(scopeOf(req), dto.connectionId, dto.links);
    }

    @Post('yavendio/import/orders')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Trae los pedidos de Yavendió a las ventas de la tienda',
        description: 'Entran como ventas (sin descontar stock ni mandar correos) solo los pedidos confirmados; los cancelados o rechazados no cuentan. Repetirlo no duplica.',
    })
    importYavendioOrders(@Body() dto: ImportarPedidosYavendioDto, @Req() req) {
        return this.yavendioOrders.import(scopeOf(req), dto.connectionId, { dryRun: dto.dryRun === true, dias: dto.dias });
    }

    @Post('falabella/connect')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
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

    @Post('woocommerce/connect')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Conecta una tienda WooCommerce a la tienda',
        description: 'Comprueba las claves con una consulta real antes de guardarlas. El Consumer Secret se guarda cifrado y nunca se devuelve. Una tienda admite hasta 3 cuentas.',
    })
    connectWooCommerce(@Body() dto: ConnectWooCommerceDto, @Req() req) {
        return this.ecommerce.connect(scopeOf(req), 'woocommerce', {
            site: dto.siteUrl,
            token: dto.consumerKey,
            secret: dto.consumerSecret,
            label: dto.label,
        });
    }

    @Post('shopify/connect')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Conecta una tienda Shopify a la tienda',
        description: 'Comprueba el token y sus permisos con una consulta real antes de guardarlo. El token se guarda cifrado y nunca se devuelve. Una tienda admite hasta 3 cuentas.',
    })
    connectShopify(@Body() dto: ConnectShopifyDto, @Req() req) {
        return this.ecommerce.connect(scopeOf(req), 'shopify', { site: dto.shop, token: dto.accessToken, label: dto.label });
    }

    @Post('ripley/connect')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Conecta una tienda de Mercado Ripley a la tienda',
        description: 'Comprueba la clave con una consulta real antes de guardarla. La clave se guarda cifrada y nunca se devuelve. Por ahora solo lee ofertas y pedidos. Una tienda admite hasta 3 cuentas.',
    })
    connectRipley(@Body() dto: ConnectRipleyDto, @Req() req) {
        return this.ecommerce.connect(scopeOf(req), 'ripley', { site: dto.site ?? '', token: dto.apiKey, label: dto.label });
    }

    @Get('ripley/categorias')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Categorías de Ripley y los atributos que exige cada una (solo lectura)',
        description: 'Busca por nombre o por código. Con pocas coincidencias trae sus atributos (obligatorios, de variante) y, si se pide, los valores permitidos de sus listas. No escribe nada.',
    })
    @ApiQuery({ name: 'buscar', required: false })
    @ApiQuery({ name: 'codigo', required: false })
    @ApiQuery({ name: 'valores', required: false })
    @ApiQuery({ name: 'valor', required: false, description: 'Con valores=1: devuelve solo los valores de las listas que contienen este texto' })
    @ApiQuery({ name: 'lista', required: false, description: 'Con valores=1: limita a una lista (p. ej. tipo_product, color_80)' })
    @ApiQuery({ name: 'connectionId', required: false })
    ripleyCategorias(@Req() req, @Query('buscar') buscar?: string, @Query('codigo') codigo?: string, @Query('valores') valores?: string, @Query('valor') valor?: string, @Query('lista') lista?: string, @Query('connectionId') connectionId?: string) {
        return this.ecommerce.categoriasDeRipley(scopeOf(req), { buscar, codigo, conValores: valores === '1' || valores === 'true', buscarValor: valor, lista }, connectionId);
    }

    @Get('ripley/vista-previa-envio')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Vista previa (solo lectura) de lo que se enviaría a Ripley para un SKU',
        description: 'Lee la oferta actual en Ripley y muestra la oferta completa que se mandaría con el stock de Synkro. No envía nada.',
    })
    @ApiQuery({ name: 'sku', required: true })
    @ApiQuery({ name: 'connectionId', required: false })
    ripleyVistaPreviaEnvio(@Req() req, @Query('sku') sku: string, @Query('connectionId') connectionId?: string) {
        return this.ecommerce.vistaPreviaDeEnvioRipley(scopeOf(req), sku, connectionId);
    }

    @Get('ripley/diagnostico')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Reconocimiento de solo lectura de Ripley: variantes, categorías y atributos',
        description: 'No escribe nada en Ripley ni devuelve la clave. Sirve para decidir cómo agrupar variantes al importar.',
    })
    @ApiQuery({ name: 'connectionId', required: false })
    ripleyDiagnostico(@Req() req, @Query('connectionId') connectionId?: string) {
        return this.ecommerce.diagnosticoDeRipley(scopeOf(req), connectionId);
    }

    @Post('ripley/colores-ia')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Sugiere el color de cada oferta de familias de Ripley mirando sus fotos',
        description: 'Solo sugiere: no escribe nada. Hasta 8 familias por llamada; solo se miran fotos de Mirakl.',
    })
    ripleyColoresIA(@Body() dto: SugerirColoresDto) {
        return this.ecommerce.sugerirColoresDeRipley(dto.familias as any);
    }

    @Post('channels/:marketplace/listings/import')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Trae los productos que ya existen en una tienda WooCommerce o Shopify',
        description: 'Los enlaza con el catálogo por SKU; los nuevos se crean como borrador. Con dryRun=true no escribe nada. En Ripley las ofertas del mismo producto se agrupan como variantes; el cuerpo puede traer familias estructuradas a mano (gruposManuales).',
    })
    @ApiQuery({ name: 'dryRun', required: false, type: Boolean })
    @ApiQuery({ name: 'connectionId', required: false, description: 'Cuenta del canal; obligatoria si la tienda tiene varias.' })
    importChannelListings(
        @Param('marketplace') marketplace: string,
        @Req() req,
        @Query('dryRun') dryRun?: string,
        @Query('connectionId') connectionId?: string,
        @Body() dto?: ImportFalabellaDto,
    ) {
        if (!ECOMMERCE_CHANNELS.includes(marketplace as EcommerceChannel)) {
            throw new NotFoundException('Ese canal no existe.');
        }
        return this.ecommerce.importListings(scopeOf(req), marketplace as EcommerceChannel, connectionId, { dryRun: dryRun === 'true', gruposManuales: dto?.gruposManuales });
    }

    @Get('listings')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.ver')
    @ApiOperation({ summary: 'Publicaciones de la tienda en todas sus cuentas de marketplaces' })
    getListings(@Req() req) {
        return this.syncService.getAllListings(scopeOf(req).storeId);
    }

    @Delete('connections/:connectionId')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({ summary: 'Desconecta una cuenta de marketplace (por su id)' })
    disconnect(@Param('connectionId') connectionId: string, @Req() req) {
        return this.syncService.disconnect(scopeOf(req).storeId, connectionId);
    }

    // ── Publishing & inventory ───────────────────────────────────

    @Post('products/:id/publish')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Publica un producto en los marketplaces indicados (asíncrono)',
        description: 'Encola un job por marketplace. Si la tienda tiene varias cuentas del canal hay que indicar cuál en connectionIds.',
    })
    publish(@Param('id') id: string, @Body() dto: PublishProductDto, @Req() req) {
        return this.syncService.enqueuePublishFamilia(scopeOf(req), id, dto.marketplaces, dto.connectionIds);
    }

    @Get('falabella/categories')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
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
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Datos obligatorios que pide una categoría de Falabella',
        description: 'Devuelve solo lo que hay que pedirle a la persona: los campos que la plataforma ya envía por su cuenta quedan fuera.',
    })
    getFalabellaCategoryFields(@Param('categoryId') categoryId: string, @Req() req, @Query('connectionId') connectionId?: string) {
        return this.syncService.getFalabellaCategoryFields(scopeOf(req), categoryId, connectionId);
    }

    @Get('falabella/categories/:categoryId/variants')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: '¿Esta categoría de Falabella admite variantes?',
        description: 'Sí si trae campos de variación («…Variant»: color, tamaño…). Si no, las variantes de un grupo se publican como productos sueltos. Solo consulta.',
    })
    getFalabellaCategoryVariants(@Param('categoryId') categoryId: string, @Req() req, @Query('connectionId') connectionId?: string) {
        return this.syncService.falabellaCategoryVariants(scopeOf(req), categoryId, connectionId);
    }

    @Get('products/:id/sheet')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('productos.ver')
    @ApiOperation({
        summary: 'Ficha del producto: lo que se envía a cada canal donde está publicado',
        description: 'Nombre, descripción, marca, categoría, atributos y medidas tal como los recibe cada marketplace, con su estado.',
    })
    getSheet(@Param('id') id: string, @Req() req) {
        return this.sheets.getSheet(scopeOf(req), id);
    }

    @Patch('products/:id/sheet')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('productos.editar')
    @ApiOperation({
        summary: 'Guarda cambios en la ficha y los envía a los canales',
        description: 'Tras guardar, el cambio se envía solo a cada canal donde el producto está publicado (en menos de un minuto; varios guardados seguidos se juntan en un envío).',
    })
    saveSheet(@Param('id') id: string, @Body() dto: SaveSheetDto, @Req() req) {
        return this.sheets.saveSheet(scopeOf(req), id, dto);
    }

    @Get('groups/:groupId/prices')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('productos.ver')
    @ApiOperation({ summary: 'Precios de un grupo de variantes: el del producto y el propio de cada canal (solo lectura)' })
    getGroupPrices(@Param('groupId') groupId: string, @Req() req) {
        return this.sheets.getGroupPrices(scopeOf(req), groupId);
    }

    @Patch('groups/:groupId/channel-prices')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('productos.editar')
    @ApiOperation({
        summary: 'Precio y descuento propios de cada canal, para todas las variantes de un grupo',
        description: 'Se aplican a las variantes publicadas en esa cuenta y salen a su canal, como al editarlos en la ficha de una variante.',
    })
    saveGroupChannelPrices(@Param('groupId') groupId: string, @Body() dto: SaveSheetDto, @Req() req) {
        return this.sheets.saveGroupPrices(scopeOf(req), groupId, dto.prices ?? []);
    }

    @Patch('groups/:groupId/inventory')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('inventario.editar')
    @ApiOperation({
        summary: 'El precio del producto para todas las variantes de un grupo',
        description: 'Con el modo revisión de la tienda encendido no toca los canales: deja una solicitud por variante y canal y responde 202.',
    })
    async updateGroupInventory(@Param('groupId') groupId: string, @Body() dto: GroupPriceDto, @Req() req, @Res({ passthrough: true }) res: Response) {
        const result = await this.syncService.updateGroupInventory(scopeOf(req), groupId, dto);
        if (result.pending) res.status(HttpStatus.ACCEPTED);
        return result;
    }

    @Patch('groups/:groupId/sheet')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('productos.editar')
    @ApiOperation({
        summary: 'Guarda lo común de un grupo de variantes en todas a la vez',
        description: 'Aplica título, descripciones, HTML, marca, medidas y atributos de los canales a todas las variantes del grupo. No toca lo propio de cada una (nombre interno, precios, color, talla…). Cada variante publicada se actualiza en sus canales, escalonado.',
    })
    saveGroupSheet(@Param('groupId') groupId: string, @Body() dto: SaveSheetDto, @Req() req) {
        return this.sheets.saveGroupSheet(scopeOf(req), groupId, dto);
    }

    @Post('products/:id/sheet/sync')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({ summary: 'Envía ya el contenido actual del producto a cada canal donde está publicado' })
    syncSheetNow(@Param('id') id: string, @Req() req) {
        return this.sheets.syncNow(scopeOf(req), id);
    }

    @Get('falabella/brands')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Busca marcas del catálogo de Falabella',
        description: 'Falabella solo acepta marcas de su catálogo (o GENERICO). Primero salen las que empiezan por el texto.',
    })
    searchFalabellaBrands(@Query('search') search: string, @Req() req, @Query('connectionId') connectionId?: string) {
        return this.syncService.searchFalabellaBrands(scopeOf(req), search || '', connectionId);
    }

    @Get('ripley/brands')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Busca marcas del catálogo de Ripley',
        description: 'Ripley solo acepta marcas de su catálogo aprobado (o GENÉRICO). Primero salen las que empiezan por el texto.',
    })
    searchRipleyBrands(@Query('search') search: string) {
        return this.ripleyMarcas.buscar(search || '');
    }

    @Get('ripley/brands/check')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Comprueba si una marca está en el catálogo de Ripley',
        description: 'Dice si la marca escrita existe (con su escritura exacta) o, si no, sugiere marcas parecidas.',
    })
    checkRipleyBrand(@Query('brand') brand: string) {
        return this.ripleyMarcas.revisar(brand || '');
    }

    @Post('mercadolibre/products/:id/link')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Enlaza un producto con una publicación que ya existe en Mercado Libre',
        description: 'No crea nada: la publicación existente se enlaza y se actualiza con los datos del producto (descripción, atributos, stock y precio).',
    })
    linkMeliListing(@Param('id') id: string, @Body() dto: LinkMeliListingDto, @Req() req) {
        return this.syncService.linkExistingMeliListing(scopeOf(req), id, dto.connectionId, dto.itemId);
    }

    @Patch('falabella/products/:id/brand')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({ summary: 'Cambia la marca con la que se publica un producto en Falabella' })
    setFalabellaBrand(@Param('id') id: string, @Body() dto: SetBrandDto, @Req() req) {
        return this.syncService.setFalabellaBrand(scopeOf(req), id, dto.brand, dto.connectionId);
    }

    @Get('ripley/categories')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({ summary: 'Busca categorías de Ripley donde se puede publicar (del catálogo ya importado)' })
    searchRipleyCategories(@Query('search') search: string) {
        return this.ripleyCatalogo.buscarCategorias(search || '');
    }

    @Get('ripley/categories/:id/fields')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Los campos que pide una categoría de Ripley',
        description: 'Con su nombre, si es obligatorio, si define la variante y sus valores (completos si la lista es corta; las largas se buscan en ripley/lists/:code/values). Dice también si la categoría admite agrupar variantes.',
    })
    getRipleyCategoryFields(@Param('id') id: string) {
        return this.ripleyCatalogo.campos(id);
    }

    @Get('ripley/lists/:code/values')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({ summary: 'Busca valores dentro de una lista cerrada de Ripley (tipo de producto, color…)' })
    searchRipleyListValues(@Param('code') code: string, @Query('search') search: string) {
        return this.ripleyCatalogo.valoresDeLista(code, search || '');
    }

    @Patch('ripley/products/:id/preparation')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Guarda la categoría y los atributos de Ripley de un producto',
        description: 'Valida los valores contra las listas de Ripley (los lleva a su escritura exacta y rechaza los que no existen). Solo guarda en Synkro: no envía nada a Ripley.',
    })
    async saveRipleyPreparation(@Param('id') id: string, @Body() dto: SaveRipleyPreparationDto, @Req() req) {
        let categoryId = dto.categoryId?.trim() || undefined;
        let ruta: string | undefined;
        let atributos: Record<string, string> | undefined;
        if (dto.attributes) {
            // Los atributos se validan contra la categoría elegida o, si no se cambió, contra la que el producto ya tiene.
            categoryId = categoryId ?? (await this.syncService.ripleyCategoryOf(scopeOf(req), id)) ?? undefined;
            if (!categoryId) throw new BadRequestException('Elige primero la categoría de Ripley.');
            const r = await this.ripleyCatalogo.validar(categoryId, dto.attributes);
            if (r.errores.length) {
                throw new BadRequestException(`Revisa estos campos: ${r.errores.map((e) => `${e.campo} (${e.motivo})`).join('; ')}.`);
            }
            ruta = r.ruta;
            atributos = r.atributos;
        } else if (categoryId) {
            ruta = await this.ripleyCatalogo.rutaDe(categoryId);
        }
        return this.syncService.saveRipleyPreparation(scopeOf(req), id, { categoryId, ruta, atributos, contenido: dto.content });
    }

    @Post('ripley/products/:id/publish-preview')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Vista previa de lo que se enviaría a Ripley (no envía nada)',
        description: 'Valida el producto contra lo que exige Ripley y arma el CSV de Productos y ofertas con las columnas oficiales: problemas por producto, si las variantes van en una publicación o separadas, y el archivo. No escribe en Ripley.',
    })
    ripleyPublishPreview(@Param('id') id: string, @Body() dto: PublishRipleyDto, @Req() req) {
        return this.ripleyPublicacion.vistaPrevia(scopeOf(req), id, { alGrupo: dto?.alGrupo === true });
    }

    @Post('ripley/products/:id/publish')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'ENVÍA el producto a Ripley (crea su ficha y su oferta)',
        description: 'Escribe en el catálogo real de la tienda. Exige a la vez: confirmar=true, el interruptor RIPLEY_PUBLISH_ENABLED encendido, el SKU en RIPLEY_PUBLISH_SKUS y cero errores en la vista previa. Devuelve los números de importación para seguirla.',
    })
    ripleyPublish(@Param('id') id: string, @Body() dto: PublishRipleyDto, @Req() req) {
        return this.ripleyPublicacion.publicar(scopeOf(req), id, { alGrupo: dto?.alGrupo === true, confirmar: dto?.confirmar === true, connectionId: dto?.connectionId });
    }

    @Get('ripley/imports/:importId')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({ summary: 'Cómo va lo enviado a Ripley (ofertas y productos) y sus errores. Solo consulta.' })
    @ApiQuery({ name: 'productImportId', required: false })
    @ApiQuery({ name: 'connectionId', required: false })
    ripleyImportStatus(@Param('importId') importId: string, @Req() req, @Query('productImportId') productImportId?: string, @Query('connectionId') connectionId?: string) {
        return this.ripleyPublicacion.estado(scopeOf(req), importId, productImportId, connectionId);
    }

    @Patch('ripley/products/:id/brand')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Cambia la marca con la que se publica un producto en Ripley',
        description: 'Solo vale una marca del catálogo aprobado de Ripley (o GENÉRICO); se guarda con su escritura exacta. No envía nada a Ripley.',
    })
    async setRipleyBrand(@Param('id') id: string, @Body() dto: SetBrandDto, @Req() req) {
        const marca = await this.ripleyMarcas.revisar(dto.brand);
        if (!marca.valida || !marca.canonica) {
            const parecidas = marca.sugerencias.length ? ` Parecidas: ${marca.sugerencias.join(', ')}.` : '';
            throw new BadRequestException(`La marca «${dto.brand.trim()}» no existe en el catálogo de Ripley. Búscala en la lista o usa GENÉRICO.${parecidas}`);
        }
        return this.syncService.setRipleyBrand(scopeOf(req), id, marca.canonica);
    }

    @Patch('falabella/products/:id/preparation')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
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
    @RequirePermission('canales.publicar')
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

    @Post('listings/resend-stock')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('inventario.editar')
    @ApiOperation({
        summary: 'Vuelve a mandar el stock de Synkro a varias publicaciones a la vez (hasta 200)',
        description: 'Aplica las mismas reglas que el reenvío individual (modo revisión, pausadas, Ripley en piloto). Responde qué se envió, qué quedó en revisión y qué se omitió y por qué.',
    })
    resendStockMasivo(@Body() dto: ResendStockMasivoDto, @Req() req) {
        return this.syncService.resendListingsStock(scopeOf(req), dto.listingIds, dto.campo ?? 'stock');
    }

    @Post('listings/:id/promo')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('inventario.editar')
    @ApiOperation({
        summary: 'Fija (o quita) el descuento de UNA cuenta de Falabella o Ripley',
        description: 'Falabella: se guarda y se envía al instante. Ripley: con el modo revisión encendido crea una solicitud pendiente y responde 202; solo cambia el descuento.',
    })
    async setListingPromo(@Param('id') id: string, @Body() dto: ListingPromoDto, @Req() req, @Res({ passthrough: true }) res: Response) {
        const result = await this.syncService.setListingPromo(scopeOf(req), id, dto);
        if (result.pending) res.status(HttpStatus.ACCEPTED);
        return result;
    }

    @Post('listings/:id/resend-price')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('inventario.editar')
    @ApiOperation({
        summary: 'Vuelve a mandar a UNA oferta de Ripley el precio normal de Synkro (solo el precio, sin rebaja)',
        description: 'Con el modo revisión encendido no toca el canal: crea una solicitud pendiente y responde 202. Las ofertas con rebaja en Ripley no se tocan.',
    })
    async resendListingPrice(@Param('id') id: string, @Req() req, @Res({ passthrough: true }) res: Response) {
        const result = await this.syncService.resendListingPrice(scopeOf(req), id);
        if (result.pending) res.status(HttpStatus.ACCEPTED);
        return result;
    }

    @Post('listings/:id/resend-stock')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('inventario.editar')
    @ApiOperation({
        summary: 'Vuelve a mandar a UNA cuenta el stock que tiene Synkro, cuando el canal quedó con otro número',
        description: 'Con el modo revisión encendido no toca el canal: crea una solicitud pendiente y responde 202.',
    })
    async resendListingStock(@Param('id') id: string, @Req() req, @Res({ passthrough: true }) res: Response) {
        const result = await this.syncService.resendListingStock(scopeOf(req), id);
        if (result.pending) res.status(HttpStatus.ACCEPTED);
        return result;
    }

    @Patch('products/:id/inventory')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('inventario.editar')
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

    @Post('falabella/variants/group')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Agrupa a mano productos ya importados como variantes (nombre, ejes y valor de cada SKU)',
        description: 'Último recurso cuando ni la página pública de Falabella ni la IA pudieron determinar los ejes. No toca fotos, precio ni stock.',
    })
    groupVariantsManually(@Body() dto: ManualVariantGroupDto, @Req() req) {
        return this.variantImport.agruparManual(scopeOf(req), dto);
    }

    @Post('products/mark-imported')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Marca como importados de un canal los productos de la tienda que tienen publicación en él y aún no tienen origen',
        description: 'Para lo importado antes de que se guardara el origen. Sin confirm: true solo cuenta cuántos se marcarían. Solo cambia el aviso «importado desde…» de la ficha.',
    })
    markImported(@Req() req, @Body() dto: MarkImportedDto) {
        return this.syncService.marcarImportados(scopeOf(req), dto.channel, dto.confirm === true);
    }

    @Post('channels/verify')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Comprueba en Mercado Libre y Falabella cómo están de verdad estos SKU (solo lee)',
        description: 'Para confirmar que algo que se quitó ya no está a la venta, leyendo el estado real en cada canal. No cambia nada.',
    })
    verifyChannels(@Req() req, @Body() dto: VerifyChannelsDto) {
        return this.listingActions.verificarEnCanales(scopeOf(req), dto.skus);
    }

    @Post('mercadolibre/duplicates/:action')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Pausa o cierra publicaciones repetidas de Mercado Libre (mismo SKU en una cuenta)',
        description: 'action = pause | close. Solo actúa sobre publicaciones que el servidor detecta como repetidas y que no son la principal de un SKU. Cerrar es definitivo en Mercado Libre.',
    })
    duplicatesAction(@Req() req, @Param('action') action: string, @Body() dto: DuplicatesActionDto) {
        if (action !== 'pause' && action !== 'close') throw new BadRequestException('La acción debe ser pause o close.');
        return this.listingActions.duplicadasMeli(scopeOf(req), dto.connectionId, action, dto.externalIds);
    }

    @Post('products/:id/channels/:action')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.publicar')
    @ApiOperation({
        summary: 'Pausa, reanuda o quita el producto de uno o de todos sus canales',
        description: 'action = pause | resume | remove. Sin linkIds actúa sobre todas las publicaciones del producto. Quitar exige confirm: true.',
    })
    async channelAction(@Param('id') id: string, @Param('action') action: string, @Body() dto: ChannelActionDto, @Req() req) {
        if (action !== 'pause' && action !== 'resume' && action !== 'remove') {
            throw new BadRequestException('La acción debe ser pause, resume o remove.');
        }
        if (action === 'remove' && dto.confirm !== true) {
            throw new BadRequestException('Quitar un producto de un canal necesita confirmación expresa (confirm: true).');
        }
        return this.listingActions.ejecutar(scopeOf(req), id, action, dto.linkIds);
    }

    @Patch('products/:id/promo')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('inventario.editar')
    @ApiOperation({
        summary: 'Fija el precio con descuento y sus fechas, y los envía a Falabella',
        description: 'El descuento debe ser menor que el precio regular. Las fechas son opcionales (AAAA-MM-DD). No pasa por la cola de revisión.',
    })
    setPromo(@Param('id') id: string, @Body() dto: PromoDto, @Req() req) {
        return this.syncService.setPromo(scopeOf(req), id, dto);
    }

    @Patch('products/:id/web-price')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('inventario.editar')
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
    @RequirePermission('canales.ver')
    @ApiOperation({ summary: 'Solicitudes de cambio de precio/stock de la tienda' })
    @ApiQuery({ name: 'status', required: false, enum: ['pending', 'approved', 'rejected', 'sent', 'error', 'skipped'] })
    listChangeRequests(@Req() req, @Query('status') status?: string) {
        return this.changeRequests.list(scopeOf(req), status);
    }

    @Post('change-requests/approve-many')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('cambios.aprobar')
    @ApiOperation({ summary: 'Aprueba varias solicitudes a la vez (un grupo de variantes o todas las pendientes), hasta 200' })
    approveManyChangeRequests(@Body() dto: ChangeRequestIdsDto, @Req() req) {
        return this.changeRequests.approveMany(dto.ids, scopeOf(req));
    }

    @Post('change-requests/reject-many')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('cambios.aprobar')
    @ApiOperation({ summary: 'Rechaza varias solicitudes a la vez, hasta 200' })
    rejectManyChangeRequests(@Body() dto: ChangeRequestIdsDto, @Req() req) {
        return this.changeRequests.rejectMany(dto.ids, scopeOf(req), dto.reason);
    }

    @Post('change-requests/:id/approve')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('cambios.aprobar')
    @ApiOperation({ summary: 'Aprueba un cambio: lo aplica al producto y lo envía al canal (asíncrono)' })
    approveChangeRequest(@Param('id') id: string, @Req() req) {
        return this.changeRequests.approve(id, scopeOf(req));
    }

    @Post('change-requests/:id/reject')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('cambios.aprobar')
    @ApiOperation({ summary: 'Rechaza un cambio: no toca el producto ni el canal' })
    rejectChangeRequest(@Param('id') id: string, @Body() dto: RejectChangeDto, @Req() req) {
        return this.changeRequests.reject(id, scopeOf(req), dto.reason);
    }

    @Get('settings')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.ver')
    @ApiOperation({ summary: 'Ajustes de sincronización de la tienda' })
    async getSyncSettings(@Req() req) {
        return { reviewMode: await this.changeRequests.isReviewMode(scopeOf(req).storeId) };
    }

    @Patch('settings/review-mode')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('cambios.aprobar')
    @ApiOperation({ summary: 'Enciende o apaga el modo revisión de la tienda' })
    setReviewMode(@Body() dto: ReviewModeDto, @Req() req) {
        return this.changeRequests.setReviewMode(scopeOf(req).storeId, dto.enabled);
    }

    @Get('products/:id/status')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.ver')
    @ApiOperation({ summary: 'Estado de sincronización del producto en cada cuenta de marketplace' })
    getStatus(@Param('id') id: string, @Req() req) {
        return this.syncService.getProductSyncStatus(scopeOf(req), id);
    }

    @Post('falabella/webhook/register')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
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
    @RequirePermission('canales.conectar')
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
    importFalabellaListings(@Req() req, @Query('dryRun') dryRun?: string, @Query('connectionId') connectionId?: string, @Body() dto?: ImportFalabellaDto) {
        return this.syncService.importFalabellaListings(scopeOf(req), connectionId, {
            dryRun: dryRun === 'true',
            gruposManuales: dto?.gruposManuales,
        });
    }

    @Post('falabella/orders/sync')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('ventas.registrar')
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
    @RequirePermission('ventas.ver')
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
    @ApiQuery({ name: 'status', required: false, description: 'Estado de la venta: pendiente, enviado, entregado, cancelado o devuelto (varios, separados por coma). Sin valor, todas.' })
    @ApiQuery({ name: 'shipping', required: false, description: 'Cómo se pagó el envío: comprador, gratis, retiro o sin_dato (varios, separados por coma). Sin valor, todas.' })
    @ApiQuery({ name: 'limit', required: false })
    @ApiQuery({ name: 'offset', required: false })
    listOrders(
        @Req() req,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('marketplace') marketplace?: string,
        @Query('connectionId') connectionId?: string,
        @Query('search') search?: string,
        @Query('status') status?: string,
        @Query('shipping') shipping?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ) {
        return this.ordersQuery.list(scopeOf(req).storeId, req.store, {
            from, to, marketplace, connectionId, search, status, shipping,
            limit: limit ? Number(limit) : undefined,
            offset: offset ? Number(offset) : undefined,
        });
    }

    @Get('orders/export')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('ventas.descargar')
    @ApiOperation({
        summary: 'Descarga en Excel las ventas que coinciden con los filtros',
        description: 'Los mismos filtros que GET /sync/orders (fechas, canal, cuenta, búsqueda y estado). Una fila por producto vendido, hasta 5000 ventas. Quien solo tiene lectura no recibe los datos de contacto del comprador.',
    })
    @ApiQuery({ name: 'from', required: false })
    @ApiQuery({ name: 'to', required: false })
    @ApiQuery({ name: 'marketplace', required: false })
    @ApiQuery({ name: 'connectionId', required: false })
    @ApiQuery({ name: 'search', required: false })
    @ApiQuery({ name: 'status', required: false })
    @ApiQuery({ name: 'shipping', required: false })
    async exportOrders(
        @Req() req,
        @Res() res: Response,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('marketplace') marketplace?: string,
        @Query('connectionId') connectionId?: string,
        @Query('search') search?: string,
        @Query('status') status?: string,
        @Query('shipping') shipping?: string,
    ) {
        const r = await this.ordersQuery.exportar(scopeOf(req).storeId, req.store, { from, to, marketplace, connectionId, search, status, shipping });
        const buffer = await escribirHoja(r.filas, 'Ventas');
        // Se responde directo: el interceptor global envolvería el archivo en JSON y Excel no podría abrirlo.
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="ventas-${new Date().toISOString().slice(0, 10)}.xlsx"`,
            'X-Ventas': String(r.ventas),
            'X-Incompleto': r.incompleto ? '1' : '0',
            'Access-Control-Expose-Headers': 'X-Ventas, X-Incompleto, Content-Disposition',
        });
        return res.send(buffer);
    }

    @Get('orders/manual/products')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('ventas.registrar')
    @ApiOperation({ summary: 'Busca productos del catálogo por SKU o nombre para elegir el de una venta manual' })
    @ApiQuery({ name: 'search', required: true })
    searchManualSaleProducts(@Req() req, @Query('search') search?: string) {
        return this.manualSales.buscarProductos(scopeOf(req), search ?? '');
    }

    @Put('orders/manual/:id')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('ventas.registrar')
    @ApiOperation({
        summary: 'Edita una venta registrada a mano o desde Excel',
        description: 'Body: { filas: [...] } con las columnas de la plantilla; todas las filas son productos de esta venta. Devuelve el stock anterior y descuenta el nuevo. Las ventas que traen los canales no se pueden editar.',
    })
    editManualSale(@Req() req, @Param('id') id: string, @Body() body: { filas?: Record<string, any>[] }) {
        return this.manualSales.editar(scopeOf(req), id, Array.isArray(body?.filas) ? body.filas : []);
    }

    @Delete('orders/manual/:id')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('ventas.registrar')
    @ApiOperation({ summary: 'Elimina una venta registrada a mano o desde Excel y devuelve al stock lo que descontó' })
    deleteManualSale(@Req() req, @Param('id') id: string) {
        return this.manualSales.eliminar(scopeOf(req), id);
    }

    @Get('orders/manual/template')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('ventas.registrar')
    @ApiOperation({ summary: 'Plantilla de Excel para registrar ventas de canales no conectados' })
    async manualSalesTemplate(@Req() req, @Res() res: Response) {
        const buffer = await plantillaDeVentas(req.store?.name ?? '');
        // Se responde directo: el interceptor global envolvería el archivo en JSON y Excel no podría abrirlo.
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': 'attachment; filename="plantilla-ventas.xlsx"',
        });
        return res.send(buffer);
    }

    @Post('orders/manual')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('ventas.registrar')
    @ApiOperation({
        summary: 'Registra a mano una venta de un canal no conectado',
        description:
            'Body: { filas: [...] } con las mismas columnas de la plantilla (numero_pedido, fecha, canal, sku, producto, cantidad, precio_unitario, envio, estado, cliente, telefono, documento, direccion, notas, descontar_stock, moneda). ' +
            'Varias filas con el mismo numero_pedido son productos de una misma venta. Descuenta el stock salvo descontar_stock = NO.',
    })
    registerManualSale(@Req() req, @Body() body: { filas?: Record<string, any>[] }) {
        const filas = Array.isArray(body?.filas) ? body.filas : [];
        if (!filas.length) throw new BadRequestException('Falta la venta: envía al menos un producto en filas.');
        const { ventas, errores } = ventasDeFilas(filas);
        const scope = scopeOf(req);
        return this.manualSales.registrar(scope, ventas).then(r => ({ registradas: r.registradas, rechazadas: [...errores, ...r.rechazadas] }));
    }

    @Post('orders/manual/import')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('ventas.registrar')
    @UseInterceptors(FileInterceptor('excel'))
    @ApiOperation({ summary: 'Registra ventas de canales no conectados desde un Excel (plantilla de ventas)' })
    importManualSales(@Req() req, @UploadedFile() excel: Express.Multer.File) {
        if (!excel) throw new BadRequestException('Falta el archivo Excel (campo «excel»).');
        return this.manualSales.importarExcel(scopeOf(req), excel.buffer);
    }

    @Post('orders/:id/restock')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('ventas.registrar')
    @ApiOperation({
        summary: 'Confirma que el producto de una venta cancelada o devuelta ya volvió al almacén',
        description: 'Repone al stock las unidades de esa venta que estaban «por reponer» (la venta ya se había enviado) y las manda a los canales.',
    })
    restockOrder(@Param('id') id: string, @Req() req) {
        return this.syncService.confirmarReposicionDeVenta(scopeOf(req), id);
    }

    @Get('orders/:id')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('ventas.ver')
    @ApiOperation({ summary: 'Detalle de una venta: cliente, envío, pago y líneas' })
    getOrder(@Param('id') id: string, @Req() req) {
        return this.ordersQuery.detail(scopeOf(req).storeId, req.store, id);
    }

    @Post('mercadolibre/listings/import')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Trae las publicaciones que ya existen en una cuenta de Mercado Libre',
        description:
            'Lee todas las publicaciones de la cuenta y las enlaza con el catálogo por SKU; cada variante es un producto. ' +
            'Con dryRun=true no escribe nada: solo informa de qué pasaría.',
    })
    @ApiQuery({ name: 'dryRun', required: false, type: Boolean })
    @ApiQuery({ name: 'connectionId', required: false, description: 'Cuenta de Mercado Libre; obligatoria si la tienda tiene varias.' })
    @ApiQuery({ name: 'generarSku', required: false, type: Boolean, description: 'Synkro da un SKU propio a lo que no tiene en Mercado Libre (sin esto, lo que no tiene SKU no se importa). No cambia nada en Mercado Libre.' })
    importMeliListings(@Req() req, @Query('dryRun') dryRun?: string, @Query('connectionId') connectionId?: string, @Query('generarSku') generarSku?: string) {
        return this.syncService.importMeliListings(scopeOf(req), connectionId, { dryRun: dryRun === 'true', generarSku: generarSku === 'true' });
    }

    @Post('listings/refresh')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Actualiza ahora el estado de las publicaciones de la tienda',
        description:
            'Vuelve a leer en cada cuenta el estado, los precios, el stock del canal y la foto de lo que ya está enlazado. ' +
            'No crea productos ni cambia el stock de Synkro.',
    })
    refreshListings(@Req() req) {
        return this.syncService.refreshStoreListings(scopeOf(req).storeId);
    }

    @Post('orders/import-history')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('canales.conectar')
    @ApiOperation({
        summary: 'Importa el historial de ventas de las cuentas de la tienda',
        description:
            'Deja la constancia de las ventas de los últimos N días (hasta 365) SIN tocar el stock ni avisar: ' +
            'esas ventas ya ocurrieron. Las últimas 48 horas las trae la consulta normal, que sí descuenta el stock.',
    })
    @ApiQuery({ name: 'days', required: false, example: 90 })
    @ApiQuery({ name: 'connectionId', required: false })
    importOrderHistory(@Req() req, @Query('days') days?: string, @Query('connectionId') connectionId?: string) {
        return this.syncService.importOrderHistory(scopeOf(req), Number(days) || 90, connectionId);
    }

    @Post('orders/sync')
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, SectionAccessGuard, StoreAccessGuard)
    @RequirePermission('ventas.registrar')
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
