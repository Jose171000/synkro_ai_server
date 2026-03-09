import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req, BadRequestException, UseInterceptors, Query } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { UploadedFiles } from '@nestjs/common';
import { ApiConsumes, ApiBody, ApiOperation } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductWithAiDto } from './dto/create-product-with-ai.dto';
import { GenerateAIContentDto } from './dto/generate-ai-content.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UploadService } from '../upload/upload.service';
import { QueryProductsDto } from './dto/query-products.dto';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly uploadService: UploadService,
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
  @ApiOperation({ summary: 'Crear un producto (sin IA) — imágenes como URLs' })
  async create(@Body() createProductDto: CreateProductDto, @Req() req) {
    await this.validateImages(createProductDto.images, true);
    return this.productsService.create(createProductDto, req.user.id);
  }

  @Post('with-files')
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

    return this.productsService.create(dto, req.user.id);
  }

  @Post('with-ai')
  @ApiOperation({ summary: 'Crear un producto con IA — imágenes como URLs' })
  async createWithAI(@Body() dto: CreateProductWithAiDto, @Req() req) {
    await this.validateImages(dto.images, true);
    return this.productsService.createWithAI(dto, req.user.id);
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

    return this.productsService.createWithAI(dto, req.user.id);
  }

  @Get()
  @ApiOperation({
    summary: 'Listar productos del usuario con filtros, búsqueda y paginación',
    description: 'Admite: `page`, `limit`, `search` (nombre/SKU/descripción), `marketplace`, `category`, `subCategory`, `minPrice`, `maxPrice`, `inStock`, `sortBy`, `order`.',
  })
  findAll(@Query() query: QueryProductsDto, @Req() req) {
    return this.productsService.findAll(req.user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un producto por ID' })
  findOne(@Param('id') id: string, @Req() req) {
    return this.productsService.findOne(id, req.user.id);
  }

  @Post(':id/generate-ai')
  @ApiOperation({ summary: 'Generar contenido IA para un producto ya existente' })
  generateAI(
    @Param('id') id: string,
    @Body() dto: GenerateAIContentDto,
    @Req() req,
  ) {
    return this.productsService.generateAIContent(id, req.user.id, {
      tone: dto.tone,
      marketplaces: dto.targetMarketplaces,
    });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar campos de un producto' })
  async update(
    @Param('id') id: string,
    @Body() updateProductDto: Partial<CreateProductDto>,
    @Req() req,
  ) {
    // Validate images only if they are being updated — if not sent, existing images remain
    await this.validateImages(updateProductDto.images, false);
    return this.productsService.update(id, updateProductDto, req.user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar un producto' })
  remove(@Param('id') id: string, @Req() req) {
    return this.productsService.remove(id, req.user.id);
  }
}
