import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireStoreRole, StoreAccessGuard } from '../stores/store-access.guard';
import { FalabellaAutoPrepService } from './falabella-auto-prep.service';

class PrepareAutoDto {
    @IsOptional()
    @IsString()
    connectionId?: string;

    /** Volver a redactar el nombre y la descripción con la IA. */
    @IsOptional()
    @IsBoolean()
    regenerar?: boolean;
}

@ApiTags('ai')
@Controller('ai')
@ApiHeader({ name: 'X-Store-Id', required: false })
export class FalabellaPrepController {
    constructor(private readonly prep: FalabellaAutoPrepService) { }

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
