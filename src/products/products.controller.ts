import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req, BadRequestException, UseInterceptors, Query, ParseUUIDPipe } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { UploadedFiles } from '@nestjs/common';
import { ApiConsumes, ApiBody, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductWithAiDto } from './dto/create-product-with-ai.dto';
import { GenerateAIContentDto } from './dto/generate-ai-content.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSection, SectionAccessGuard } from '../common/guards/section-access.guard';
import { RequirePermission, StoreAccessGuard } from '../stores/store-access.guard';
import { ProductGroupsService } from './product-groups.service';
import { SkuGeneratorService } from './sku-generator.service';
import { AddVariantsDto, CreateProductGroupDto } from './dto/product-group.dto';
import { UpdateProductGroupDto } from './dto/update-product-group.dto';
import { PrepararRipleyDto } from './dto/preparar-ripley.dto';
import { VariantCompatService } from './variant-compat.service';
import { RellenarRipleyDto } from './dto/rellenar-ripley.dto';
import { RegenerarGrupoDto } from './dto/regenerar-grupo.dto';
import { RenombrarEjeDto } from './dto/renombrar-eje.dto';
import { AplicarAjustesDto, SugerirAjustesDto } from './dto/ajustes-de-canal.dto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UploadService } from '../upload/upload.service';
import { SyncService } from '../sync/sync.service';
import { MAX_PRODUCTOS_POR_CONSULTA, ProductOverviewService } from '../sync/product-overview.service';
import { QueryProductsDto } from './dto/query-products.dto';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
@UseGuards(JwtAuthGuard, SectionAccessGuard)
@RequireSection('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly uploadService: UploadService,
    private readonly syncService: SyncService,
    private readonly groups: ProductGroupsService,
    private readonly skuGenerator: SkuGeneratorService,
    private readonly overview: ProductOverviewService,
    private readonly variantCompat: VariantCompatService,
  ) { }

  /**
   * Validates image URLs (reachable, JPEG, ≤ 2000x2000px).
   * @param images   URL array from the request body
   * @param required If true, throws when images is absent or empty
   */
  private async validateImages(images: string[] | undefined, required = false): Promise<void> {
    if (!images?.length) {
      if (required) {
        throw new BadRequestException('El campo images es obligatorio y debe contener al menos una imagen JPG válida.');
      }
      return;
    }
    const results = await Promise.allSettled(
      images.map(url => this.uploadService.validateExternalUrl(url))
    );
    const errors = results
      .map((r, i) => r.status === 'rejected' ? `images[${i}] (${images[i]}): ${r.reason?.message}` : null)
      .filter(Boolean);
    if (errors.length) {
      throw new BadRequestException({ message: 'Una o más imágenes son inválidas.', errors });
    }
  }

  @Post()
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({ summary: 'Crear un producto (sin IA) — imágenes como URLs' })
  async create(@Body() createProductDto: CreateProductDto, @Req() req) {
    await this.validateImages(createProductDto.images, true);
    return this.productsService.create(createProductDto, req.user.id, req.store?.storeId);
  }

  @Post('with-files')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({
    summary: 'Crear un producto (sin IA) — imágenes como archivos físicos',
    description: 'Envía los datos del producto como JSON en el campo `data` y las imágenes como archivos en el campo `images`. Las imágenes se suben automáticamente a Cloudinary (JPG, máx. 10 MB, máx. 2000x2000px).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        data:   { type: 'string', description: 'JSON con los campos del producto' },
        images: { type: 'array', items: { type: 'string', format: 'binary' } },
      },
      required: ['data', 'images'],
    },
  })
  @UseInterceptors(AnyFilesInterceptor())
  async createWithFiles(@UploadedFiles() files: Express.Multer.File[], @Req() req) {
    const imageFiles = files?.filter(f => f.fieldname === 'images') ?? [];
    if (!imageFiles.length) {
      throw new BadRequestException('Al menos una imagen es obligatoria (campo: images).');
    }
    const dataField = files?.find(f => f.fieldname === 'data');
    if (!dataField) throw new BadRequestException('El campo data (JSON) es obligatorio.');

    let dto: CreateProductDto;
    try { dto = JSON.parse(dataField.buffer.toString('utf-8')); }
    catch { throw new BadRequestException('El campo data no contiene un JSON válido.'); }

    // Upload all images to Cloudinary — validates JPEG + dimensions
    const results = await this.uploadService.uploadImages(imageFiles, 'products');
    dto.images = results.map(r => r.secureUrl);

    return this.productsService.create(dto, req.user.id, req.store?.storeId);
  }

  @Get('sku/next')
  @RequirePermission('productos.editar')
  @UseGuards(StoreAccessGuard)
  @ApiOperation({ summary: 'Los próximos SKU que se asignarían en la tienda activa', description: 'Sigue el formato del último bloque de productos publicados de la tienda; sin publicados, usa INICIALES-0001. Solo informa: no reserva el SKU.' })
  async nextSku(@Req() req, @Query('count') count?: string) {
    const n = Math.min(Math.max(parseInt(String(count ?? '1'), 10) || 1, 1), 50);
    return { skus: await this.skuGenerator.siguientes({ userId: req.user.id, storeId: req.store.storeId }, n) };
  }

  @Post('groups')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({
    summary: 'Crear un producto con variantes',
    description: 'Crea el grupo y todas sus variantes en un solo paso (cada variante es un producto con su SKU único en la tienda). Los SKU que no se escriban se generan a partir del código del grupo y los valores.',
  })
  createGroup(@Body() dto: CreateProductGroupDto, @Req() req) {
    return this.groups.crear(dto, { userId: req.user.id, storeId: req.store.storeId });
  }

  @Post('variants/detect')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({
    summary: 'Filtro previo: ¿el producto parece tener variantes?',
    description: 'Recibe las fotos como archivos (campo images, hasta 8) y el texto del cliente (campo text). Mira las fotos, incluido el texto que aparezca en ellas. Solo recomienda variantes con evidencia concreta; sin ella devuelve recomendar = false. No guarda las fotos.',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(AnyFilesInterceptor())
  async detectVariants(@UploadedFiles() files: Express.Multer.File[], @Body('text') text?: string) {
    const imagenes = (files ?? []).filter((f) => f.fieldname === 'images' && /^image\//.test(f.mimetype)).slice(0, 8);
    const urls = imagenes.map((f) => `data:${f.mimetype};base64,${f.buffer.toString('base64')}`);
    return { resultado: await this.groups.detectar(urls, text) };
  }

  @Get('groups/:id')
  @RequirePermission('productos.ver')
  @UseGuards(StoreAccessGuard)
  @ApiOperation({ summary: 'Un producto con variantes y todas sus variantes' })
  getGroup(@Param('id') id: string, @Req() req) {
    return this.groups.obtener(id, { userId: req.user.id, storeId: req.store.storeId });
  }

  @Get('groups/:id/variant-compat')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('canales.publicar')
  @ApiOperation({
    summary: 'Revisa si las variantes de un grupo caben en UNA publicación de cada canal',
    description: 'Compara los ejes del grupo con lo que admite la categoría que tiene en cada canal (la guardada, o la que se indique en categoryId si se pide un solo canal). Si no caben, dice que se publicarán como productos separados y, cuando es por la categoría, recomienda otra parecida que sí las admite (sin cambiarla). Solo consulta.',
  })
  @ApiQuery({ name: 'marketplace', required: true, description: 'Canales separados por coma: ripley,falabella,mercadolibre' })
  @ApiQuery({ name: 'categoryId', required: false })
  variantCompatibility(@Param('id') id: string, @Query('marketplace') marketplace: string, @Query('categoryId') categoryId: string | undefined, @Req() req) {
    const canales = String(marketplace ?? '').split(',').map((m) => m.trim()).filter(Boolean).slice(0, 8);
    // Una categoría indicada solo vale cuando se pide un único canal.
    return this.variantCompat.revisar(id, canales.map((m) => ({ marketplace: m, ...(canales.length === 1 && categoryId ? { categoryId } : {}) })), { userId: req.user.id, storeId: req.store.storeId });
  }

  @Post('groups/:id/channel-values/suggest')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('canales.publicar')
  @ApiOperation({
    summary: 'La IA propone a qué opción válida de un canal corresponde cada color, talla o tamaño que el canal no tiene en su lista',
    description: 'Para los valores del grupo que no existen en la lista cerrada del canal (o que caerían en la misma opción), propone la opción válida más cercana mirando el nombre del producto y, si hace falta, la foto de la variante. Solo consulta: no cambia nada.',
  })
  suggestChannelValues(@Param('id') id: string, @Body() dto: SugerirAjustesDto, @Req() req) {
    return this.variantCompat.sugerirAjustes(id, dto.marketplace, { userId: req.user.id, storeId: req.store.storeId });
  }

  @Post('groups/:id/channel-values/apply')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('canales.publicar')
  @ApiOperation({
    summary: 'Guarda a qué opción de un canal corresponde cada valor confirmado',
    description: 'Solo vale para ese canal: el color o la talla que escribió la persona no cambia en Synkro ni en los demás canales. Solo acepta opciones que existan en la lista del canal. No envía nada al canal.',
  })
  applyChannelValues(@Param('id') id: string, @Body() dto: AplicarAjustesDto, @Req() req) {
    return this.variantCompat.aplicarAjustes(id, dto.marketplace, dto.cambios, { userId: req.user.id, storeId: req.store.storeId });
  }

  @Patch('groups/:id')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({
    summary: 'Guardar lo común de un producto con variantes en todas a la vez',
    description: 'Aplica la descripción, la categoría, la subcategoría y los marketplaces destino a todas las variantes. El nombre, el SKU, el precio, el stock y las fotos de cada una no se tocan.',
  })
  updateGroup(@Param('id') id: string, @Body() dto: UpdateProductGroupDto, @Req() req) {
    return this.groups.actualizarGeneral(id, dto, { userId: req.user.id, storeId: req.store.storeId });
  }

  @Post('groups/:id/generate-ai')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({
    summary: 'Regenerar con IA el contenido de un producto con variantes (una sola vez para todo el grupo)',
    description: 'La IA recibe la información general del grupo, los ejes con todos sus valores y una foto de cada variante (hasta el límite de fotos). El título, la descripción y la ficha HTML resultantes se aplican a todas las variantes; lo propio de cada una (nombre, color, talla, precio, stock) no se toca.',
  })
  async regenerateGroup(@Param('id') id: string, @Body() dto: RegenerarGrupoDto, @Req() req) {
    return this.groups.regenerarContenido(id, { tone: dto.tone, marketplaces: dto.targetMarketplaces }, { userId: req.user.id, storeId: req.store.storeId });
  }

  @Patch('groups/:id/axes')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({
    summary: 'Renombrar un eje de variación de un grupo («Talla» → «Tamaño cama»)',
    description: 'Cambia solo el nombre del eje, en el grupo y en cada variante; los valores no se tocan. Sirve para que el eje coincida con el dato de variante que pide un canal. No modifica ningún canal.',
  })
  renameGroupAxis(@Param('id') id: string, @Body() dto: RenombrarEjeDto, @Req() req) {
    return this.groups.renombrarEje(id, dto.from, dto.to, { userId: req.user.id, storeId: req.store.storeId });
  }

  @Post('groups/:id/align-axes')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({
    summary: 'Corregir el color y la talla guardados en cada variante de un grupo',
    description: 'Deja en los atributos de cada variante su propio color y talla (en vez del valor general que dedujo la IA). No usa la IA ni toca nada más.',
  })
  async alignGroupAxes(@Param('id') id: string, @Req() req) {
    return this.groups.alinearEjes(id, { userId: req.user.id, storeId: req.store.storeId });
  }

  @Post(':id/variants')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({
    summary: 'Agregar variantes a un producto ya creado',
    description: 'Si el producto es simple se convierte en grupo (conserva su SKU, stock, fotos y enlaces; pasa a ser la primera variante). Hay que indicar los ejes completos y qué variante es el producto actual (thisVariant). Si ya es un grupo, las variantes se suman a él.',
  })
  addVariants(@Param('id') id: string, @Body() dto: AddVariantsDto, @Req() req) {
    return this.groups.agregarVariantes(id, dto, { userId: req.user.id, storeId: req.store.storeId });
  }

  @Post('with-ai')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({ summary: 'Crear un producto con IA — imágenes como URLs' })
  async createWithAI(@Body() dto: CreateProductWithAiDto, @Req() req) {
    await this.validateImages(dto.images, true);
    return this.productsService.createWithAI(dto, req.user.id, req.store?.storeId);
  }

  @Post('with-ai/with-files')
  @ApiOperation({
    summary: 'Crear un producto con IA — imágenes como archivos físicos',
    description: 'Igual que `with-ai` pero acepta imágenes como archivos en el campo `images`. Los campos del producto van en `data` (JSON string).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        data:   { type: 'string', description: 'JSON con los campos del producto (igual que /with-ai)' },
        images: { type: 'array', items: { type: 'string', format: 'binary' } },
      },
      required: ['data', 'images'],
    },
  })
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @UseInterceptors(AnyFilesInterceptor())
  async createWithAIAndFiles(@UploadedFiles() files: Express.Multer.File[], @Req() req) {
    const imageFiles = files?.filter(f => f.fieldname === 'images') ?? [];
    if (!imageFiles.length) {
      throw new BadRequestException('Al menos una imagen es obligatoria (campo: images).');
    }
    const dataField = files?.find(f => f.fieldname === 'data');
    if (!dataField) throw new BadRequestException('El campo data (JSON) es obligatorio.');

    let dto: CreateProductWithAiDto;
    try { dto = JSON.parse(dataField.buffer.toString('utf-8')); }
    catch { throw new BadRequestException('El campo data no contiene un JSON válido.'); }

    // Upload all images to Cloudinary — validates JPEG + dimensions
    const results = await this.uploadService.uploadImages(imageFiles, 'products');
    dto.images = results.map(r => r.secureUrl);

    return this.productsService.createWithAI(dto, req.user.id, req.store?.storeId);
  }

  @Get('overview')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.ver')
  @ApiOperation({
    summary: 'Categoría real, estado real en cada canal y qué falta para publicar, de los productos indicados',
    description: 'ids = identificadores separados por coma (máximo 100). Usa las mismas reglas que se aplican al publicar.',
  })
  productOverview(@Query('ids') ids: string, @Req() req) {
    const lista = String(ids ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (lista.length > MAX_PRODUCTOS_POR_CONSULTA) throw new BadRequestException(`Máximo ${MAX_PRODUCTOS_POR_CONSULTA} productos por consulta.`);
    return this.overview.obtener({ userId: req.user.id, storeId: req.store.storeId }, lista);
  }

  @Get('summary')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.ver')
  @ApiOperation({ summary: 'Cuántos productos de la tienda no tienen categoría, no están publicados, tienen error o están incompletos' })
  summary(@Req() req) {
    return this.productsService.resumen({ userId: req.user.id, storeId: req.store.storeId });
  }

  @Get()
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.ver')
  @ApiOperation({
    summary: 'Listar los productos de la tienda activa con filtros, búsqueda y paginación',
    description: 'Admite: `page`, `limit`, `search` (nombre/SKU/descripción), `marketplace`, `category`, `subCategory`, `minPrice`, `maxPrice`, `inStock`, `sortBy`, `order`.',
  })
  findAll(@Query() query: QueryProductsDto, @Req() req) {
    return this.productsService.findAll({ userId: req.user.id, storeId: req.store.storeId }, query);
  }

  @Get(':id')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.ver')
  @ApiOperation({ summary: 'Obtener un producto por ID' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req) {
    return this.productsService.findOne(id, req.user.id, req.store.storeId);
  }

  @Post(':id/ripley/fill-attributes')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('canales.publicar')
  @ApiOperation({
    summary: 'Llenar con IA los atributos VACÍOS de la categoría de Ripley ya elegida',
    description: 'No cambia la categoría, no pisa lo ya escrito y no toca el contenido. Para un grupo de variantes analiza la información general, una foto de cada variante (hasta el límite) y todos los ejes. No guarda nada: devuelve los valores.',
  })
  fillRipleyAttributes(@Param('id') id: string, @Body() dto: RellenarRipleyDto, @Req() req) {
    return this.productsService.rellenarAtributosDeRipley(id, req.user.id, { categoryId: dto.categoryId, actuales: dto.actuales, alGrupo: dto.alGrupo === true }, req.store.storeId);
  }

  @Post(':id/prepare-ripley')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('canales.publicar')
  @ApiOperation({
    summary: 'Preparar un producto para Ripley con IA (categoría y atributos)',
    description: 'La IA elige y verifica la categoría de Ripley, redacta con sus reglas y rellena los atributos llevando cada valor a las listas cerradas del canal. Lo que no se pueda deducir sale en `faltantes`. Con guardar=false (por defecto) es solo una vista previa; con guardar=true se anota en el producto. Nunca envía nada a Ripley.',
  })
  prepareRipley(@Param('id') id: string, @Body() dto: PrepararRipleyDto, @Req() req) {
    return this.productsService.prepararParaRipley(id, req.user.id, { guardar: dto?.guardar === true, alGrupo: dto?.alGrupo === true }, req.store.storeId);
  }

  @Post(':id/generate-ai')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({ summary: 'Generar contenido IA para un producto ya existente' })
  generateAI(
    @Param('id') id: string,
    @Body() dto: GenerateAIContentDto,
    @Req() req,
  ) {
    return this.productsService.generateAIContent(id, req.user.id, {
      tone: dto.tone,
      marketplaces: dto.targetMarketplaces,
    }, req.store.storeId);
  }

  @Patch(':id')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.editar')
  @ApiOperation({ summary: 'Actualizar campos de un producto' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateProductDto: Partial<CreateProductDto>,
    @Req() req,
  ) {
    // Validate images only if they are being updated — if not sent, existing images remain
    await this.validateImages(updateProductDto.images, false);
    const actualizado = await this.productsService.update(id, updateProductDto, req.user.id, req.store.storeId);
    // Si cambió lo que ven los compradores, se manda solo a cada canal donde el producto está publicado.
    if (updateProductDto.name !== undefined || updateProductDto.description !== undefined || updateProductDto.images !== undefined) {
      void this.syncService.scheduleContentSync(id).catch(() => undefined);
    }
    return actualizado;
  }

  @Delete(':id')
  @UseGuards(StoreAccessGuard)
  @RequirePermission('productos.eliminar')
  @ApiOperation({ summary: 'Eliminar un producto de la tienda activa' })
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() req) {
    return this.productsService.remove(id, req.user.id, req.store.storeId);
  }
}
