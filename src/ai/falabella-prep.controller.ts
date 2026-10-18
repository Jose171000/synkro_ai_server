import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireStoreRole, StoreAccessGuard } from '../stores/store-access.guard';
import { FalabellaAutoPrepService } from './falabella-auto-prep.service';
import { ProductLaunchService } from './product-launch.service';

class PrepareAutoDto {
    @IsOptional()
    @IsString()
    connectionId?: string;

    /** Volver a redactar el nombre y la descripción con la IA. */
    @IsOptional()
    @IsBoolean()
    regenerar?: boolean;
}

class SuggestDto {
    @IsString()
    categoryId: string;

    @IsOptional()
    @IsString()
    connectionId?: string;
}

class LaunchDto {
    @IsArray()
    @ArrayNotEmpty()
    @IsString({ each: true })
    marketplaces: string[];
}

@ApiTags('ai')
@Controller('ai')
@ApiHeader({ name: 'X-Store-Id', required: false })
export class FalabellaPrepController {
    constructor(
        private readonly prep: FalabellaAutoPrepService,
        private readonly launch: ProductLaunchService,
    ) { }

    @Post('products/:id/prepare-falabella')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Deja un producto listo para Falabella en un solo paso',
        description:
            'Elige la categoría si falta, comprueba la marca contra el catálogo, estima las medidas del paquete y ' +
            'completa los datos obligatorios de la categoría. Devuelve qué se hizo y si ya puede publicarse.',
    })
    prepare(@Param('id') id: string, @Body() dto: PrepareAutoDto, @Req() req) {
        return this.prep.preparar({ userId: req.user.id, storeId: req.store.storeId }, id, dto?.connectionId, { regenerar: dto?.regenerar });
    }

    @Post('products/:id/suggest-falabella-attributes')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Valores sugeridos para todos los atributos de una categoría de Falabella',
        description: 'No guarda nada: sirve para que, al elegir la categoría, los campos aparezcan llenos con lo que se pudo sacar del producto.',
    })
    suggest(@Param('id') id: string, @Body() dto: SuggestDto, @Req() req) {
        return this.prep.sugerirAtributos({ userId: req.user.id, storeId: req.store.storeId }, id, dto.categoryId, dto.connectionId);
    }

    @Post('products/:id/launch')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Lanza el producto: deja listos los canales y lo publica',
        description:
            'Falabella: categoría, marca contra su catálogo, medidas, todos los atributos y descripción HTML. ' +
            'Mercado Libre: completa los atributos obligatorios que falten. Luego encola la publicación en cada cuenta activa. ' +
            'Lo que la IA estimó queda marcado para revisarlo desde la ficha.',
    })
    launchProduct(@Param('id') id: string, @Body() dto: LaunchDto, @Req() req) {
        return this.launch.lanzar({ userId: req.user.id, storeId: req.store.storeId }, id, dto.marketplaces);
    }

    @Post('products/:id/update-falabella')
    @HttpCode(HttpStatus.OK)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, StoreAccessGuard)
    @RequireStoreRole('owner')
    @ApiOperation({
        summary: 'Actualiza en Falabella una ficha ya publicada',
        description:
            'Completa lo que falte (atributos, medidas, descripción HTML) y envía a Falabella el nombre, la descripción, ' +
            'la marca y los atributos actuales. Con regenerar=true la IA vuelve a redactar nombre y descripción.',
    })
    update(@Param('id') id: string, @Body() dto: PrepareAutoDto, @Req() req) {
        return this.prep.actualizarEnFalabella({ userId: req.user.id, storeId: req.store.storeId }, id, {
            regenerar: dto?.regenerar,
            connectionId: dto?.connectionId,
        });
    }
}
