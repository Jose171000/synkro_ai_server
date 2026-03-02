import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductWithAiDto } from './dto/create-product-with-ai.dto';
import { GenerateAIContentDto } from './dto/generate-ai-content.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) { }

  @Post()
  @ApiOperation({ summary: 'Crear un producto (sin IA)' })
  create(@Body() createProductDto: CreateProductDto, @Req() req) {
    return this.productsService.create(createProductDto, req.user.id);
  }

  @Post('with-ai')
  @ApiOperation({ summary: 'Crear un producto y generar su contenido IA en un solo paso' })
  createWithAI(@Body() dto: CreateProductWithAiDto, @Req() req) {
    return this.productsService.createWithAI(dto, req.user.id);
  }

  @Get()
  @ApiOperation({ summary: 'Obtener todos los productos del usuario autenticado' })
  findAll(@Req() req) {
    return this.productsService.findAll(req.user.id);
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
  update(
    @Param('id') id: string,
    @Body() updateProductDto: Partial<CreateProductDto>,
    @Req() req,
  ) {
    return this.productsService.update(id, updateProductDto, req.user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar un producto' })
  remove(@Param('id') id: string, @Req() req) {
    return this.productsService.remove(id, req.user.id);
  }
}
