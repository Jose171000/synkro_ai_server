import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { GenerateAIContentDto } from './dto/generate-ai-content.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  create(@Body() createProductDto: CreateProductDto, @Req() req) {
    return this.productsService.create(createProductDto, req.user.sub);
  }

  @Get()
  findAll(@Req() req) {
    return this.productsService.findAll(req.user.sub);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req) {
    return this.productsService.findOne(id, req.user.sub);
  }

  @Post(':id/generate-ai')
  generateAI(
    @Param('id') id: string,
    @Body() dto: GenerateAIContentDto,
    @Req() req,
  ) {
    return this.productsService.generateAIContent(id, req.user.sub, {
      tone: dto.tone,
      marketplaces: dto.targetMarketplaces,
    });
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateProductDto: Partial<CreateProductDto>,
    @Req() req,
  ) {
    return this.productsService.update(id, updateProductDto, req.user.sub);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req) {
    return this.productsService.remove(id, req.user.sub);
  }
}
