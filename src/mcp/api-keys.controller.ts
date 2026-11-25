import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ApiKeysService, MAX_DIAS_DE_VIDA, PERMISOS_MCP } from './api-keys.service';
import { McpEscriturasService } from './mcp-escrituras.service';

export class CreateApiKeyDto {
    @IsString()
    @MaxLength(60)
    name: string;

    /** Ver `PERMISOS_MCP`. Sin esto, los de por defecto: solo lectura, sin contacto de clientes ni costos. */
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    permissions?: string[];

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(MAX_DIAS_DE_VIDA)
    expiresInDays?: number;
}

/** Claves de acceso al MCP de una tienda. Solo las gestiona el dueño (se comprueba por rol, como el equipo y los roles). */
@ApiTags('stores')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stores')
export class ApiKeysController {
    constructor(private readonly keys: ApiKeysService, private readonly escrituras: McpEscriturasService) { }

    @Get('mcp/permissions')
    @ApiOperation({ summary: 'Permisos que puede llevar una clave del MCP' })
    permisos() {
        return { permissions: PERMISOS_MCP };
    }

    @Get(':storeId/api-keys')
    @ApiOperation({ summary: 'Claves del MCP de la tienda (solo el dueño). Nunca incluye la clave completa.' })
    list(@Param('storeId') storeId: string, @Req() req) {
        return this.keys.listar(req.user.id, storeId);
    }

    @Get(':storeId/mcp-changes')
    @ApiOperation({ summary: 'Los últimos cambios hechos por asistentes en la tienda (solo el dueño)' })
    async cambios(@Param('storeId') storeId: string, @Req() req) {
        await this.keys.exigirDueno(req.user.id, storeId);
        return this.escrituras.recientes(storeId);
    }

    @Post(':storeId/api-keys')
    @ApiOperation({ summary: 'Crea una clave del MCP (solo el dueño)', description: 'La clave completa se devuelve UNA sola vez, en `key`.' })
    create(@Param('storeId') storeId: string, @Body() dto: CreateApiKeyDto, @Req() req) {
        return this.keys.crear(req.user.id, storeId, dto);
    }

    @Delete(':storeId/api-keys/:id')
    @ApiOperation({ summary: 'Revoca una clave del MCP (solo el dueño); deja de funcionar al instante' })
    revoke(@Param('storeId') storeId: string, @Param('id') id: string, @Req() req) {
        return this.keys.revocar(req.user.id, storeId, id);
    }
}
