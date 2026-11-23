import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { ApiKeysService, MAX_CLAVES_PLATAFORMA_ACTIVAS, MAX_DIAS_PLATAFORMA } from './api-keys.service';
import { DESCRIPCION_PLATAFORMA, PERMISOS_PLATAFORMA, PERMISOS_PLATAFORMA_POR_DEFECTO } from './permisos-plataforma';

export class CreatePlatformKeyDto {
    @IsString()
    @MaxLength(60)
    name: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    permissions?: string[];

    /** Obligatoria para una clave de plataforma (1 a 90 días); el servicio la exige. */
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(MAX_DIAS_PLATAFORMA)
    expiresInDays?: number;
}

/**
 * Claves del MCP vistas por un superadmin: TODAS (de todas las tiendas y de plataforma), con quién las creó, y poder revocar
 * cualquiera. Solo rol admin. Nadie puede ver el valor de una clave, ni siquiera un superadmin: solo se guarda su hash.
 */
@ApiTags('admin-mcp')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/api-keys')
export class AdminApiKeysController {
    constructor(private readonly keys: ApiKeysService) { }

    // Declarada antes de ':id' para que 'permissions' no se lea como un id.
    @Get('permissions')
    @ApiOperation({ summary: 'Permisos que puede llevar una clave de plataforma, con su descripción' })
    permisos() {
        return {
            permissions: PERMISOS_PLATAFORMA.map((clave) => ({ clave, ...DESCRIPCION_PLATAFORMA[clave] })),
            defaults: PERMISOS_PLATAFORMA_POR_DEFECTO,
            maxDays: MAX_DIAS_PLATAFORMA,
            maxActive: MAX_CLAVES_PLATAFORMA_ACTIVAS,
        };
    }

    @Get()
    @ApiOperation({ summary: 'Todas las claves del MCP (de tienda y de plataforma), con su tienda y su creador. Nunca la clave.' })
    @ApiQuery({ name: 'storeId', required: false })
    @ApiQuery({ name: 'kind', required: false, enum: ['store', 'platform'] })
    @ApiQuery({ name: 'estado', required: false, enum: ['activa', 'revocada', 'caducada'] })
    list(@Req() req, @Query('storeId') storeId?: string, @Query('kind') kind?: string, @Query('estado') estado?: string) {
        return this.keys.listarTodas(req.user.id, { storeId, kind: kind as any, estado: estado as any });
    }

    @Post()
    @ApiOperation({
        summary: 'Crea una clave de plataforma (la del MCP de superadmin)',
        description: 'Caduca obligatoriamente (máx. 90 días). La clave completa se devuelve UNA sola vez, en `key`. Para una clave de una tienda concreta se usa `POST /stores/:storeId/api-keys`, que un superadmin también puede usar en cualquier tienda.',
    })
    create(@Body() dto: CreatePlatformKeyDto, @Req() req) {
        return this.keys.crearPlataforma(req.user.id, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Revoca cualquier clave del MCP; deja de funcionar al instante' })
    revoke(@Param('id', ParseUUIDPipe) id: string, @Req() req) {
        return this.keys.revocarComoSuperadmin(req.user.id, id);
    }
}
