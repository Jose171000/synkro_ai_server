import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AcceptInvitationDto, asignacionDe, ChangeRoleDto, CreateRoleDto, CreateStoreDto, InviteDto, PublicLinkDto, UpdateRoleDto } from './dto/store.dto';
import { StoresService } from './stores.service';
import { catalogoDePermisos, StoreRolesService } from './store-roles.service';

@ApiTags('stores')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stores')
export class StoresController {
    constructor(private readonly stores: StoresService, private readonly roles: StoreRolesService) { }

    @Post()
    @ApiOperation({ summary: 'Crea una tienda; quien la crea queda como dueño' })
    create(@Body() dto: CreateStoreDto, @Req() req) {
        return this.stores.create(req.user.id, dto.name, dto.ownerId);
    }

    @Get()
    @ApiOperation({ summary: 'Tiendas a las que el usuario tiene acceso (selector de tiendas)' })
    listMine(@Req() req) {
        return this.stores.listMine(req.user.id);
    }

    // Declarada antes de ':storeId/...' para que 'permissions' no se lea como un id.
    @Get('permissions/catalog')
    @ApiOperation({ summary: 'Catálogo de permisos y roles de fábrica, para dibujar la pantalla de roles' })
    catalog() {
        return catalogoDePermisos();
    }

    // Declarada antes de ':storeId/...' para que 'invitations' no se lea como un id.
    @Post('invitations/accept')
    @ApiOperation({ summary: 'Acepta una invitación con el código del correo' })
    accept(@Body() dto: AcceptInvitationDto, @Req() req) {
        return this.stores.acceptInvitation(req.user.id, dto.token);
    }

    @Patch(':storeId')
    @ApiOperation({ summary: 'Renombra la tienda (solo el dueño)' })
    rename(@Param('storeId') storeId: string, @Body() dto: CreateStoreDto, @Req() req) {
        return this.stores.rename(req.user.id, storeId, dto.name);
    }

    @Get(':storeId/members')
    @ApiOperation({ summary: 'Miembros de la tienda' })
    members(@Param('storeId') storeId: string, @Req() req) {
        return this.stores.listMembers(req.user.id, storeId);
    }

    @Patch(':storeId/members/:userId')
    @ApiOperation({ summary: 'Cambia el rol de un miembro (solo el dueño)' })
    changeRole(@Param('storeId') storeId: string, @Param('userId') userId: string, @Body() dto: ChangeRoleDto, @Req() req) {
        return this.stores.changeRole(req.user.id, storeId, userId, asignacionDe(dto));
    }

    @Delete(':storeId/members/:userId')
    @ApiOperation({ summary: 'Quita a un miembro de la tienda (solo el dueño)' })
    removeMember(@Param('storeId') storeId: string, @Param('userId') userId: string, @Req() req) {
        return this.stores.removeMember(req.user.id, storeId, userId);
    }

    @Post(':storeId/invitations')
    @ApiOperation({ summary: 'Invita por correo a una persona a la tienda (solo el dueño)' })
    invite(@Param('storeId') storeId: string, @Body() dto: InviteDto, @Req() req) {
        return this.stores.invite(req.user.id, storeId, dto.email, asignacionDe(dto));
    }

    @Get(':storeId/invitations')
    @ApiOperation({ summary: 'Invitaciones pendientes (solo el dueño)' })
    invitations(@Param('storeId') storeId: string, @Req() req) {
        return this.stores.listInvitations(req.user.id, storeId);
    }

    @Delete(':storeId/invitations/:invitationId')
    @ApiOperation({ summary: 'Anula una invitación (solo el dueño)' })
    revoke(@Param('storeId') storeId: string, @Param('invitationId') invitationId: string, @Req() req) {
        return this.stores.revokeInvitation(req.user.id, storeId, invitationId);
    }

    @Get(':storeId/roles')
    @ApiOperation({ summary: 'Roles de la tienda: los de fábrica y los personalizados, con cuántas personas tiene cada uno (solo el dueño)' })
    listRoles(@Param('storeId') storeId: string, @Req() req) {
        return this.roles.list(req.user.id, storeId);
    }

    @Post(':storeId/roles')
    @ApiOperation({ summary: 'Crea un rol personalizado de la tienda (solo el dueño)' })
    createRole(@Param('storeId') storeId: string, @Body() dto: CreateRoleDto, @Req() req) {
        return this.roles.create(req.user.id, storeId, dto.name, dto.permissions);
    }

    @Patch(':storeId/roles/:roleId')
    @ApiOperation({ summary: 'Cambia el nombre o los permisos de un rol personalizado; vale desde la siguiente acción de quienes lo tienen (solo el dueño)' })
    updateRole(@Param('storeId') storeId: string, @Param('roleId') roleId: string, @Body() dto: UpdateRoleDto, @Req() req) {
        return this.roles.update(req.user.id, storeId, roleId, dto);
    }

    @Delete(':storeId/roles/:roleId')
    @ApiOperation({ summary: 'Borra un rol personalizado; no se puede si alguien lo tiene o hay una invitación pendiente con él (solo el dueño)' })
    deleteRole(@Param('storeId') storeId: string, @Param('roleId') roleId: string, @Req() req) {
        return this.roles.remove(req.user.id, storeId, roleId);
    }

    @Patch(':storeId/public-link')
    @ApiOperation({ summary: 'Activa, apaga o regenera el enlace público de información general (solo el dueño)' })
    publicLink(@Param('storeId') storeId: string, @Body() dto: PublicLinkDto, @Req() req) {
        return this.stores.setPublicLink(req.user.id, storeId, dto.enabled, dto.regenerate);
    }
}

/** Sin sesión: lo que cualquiera puede ver con el enlace de la tienda. */
@ApiTags('stores')
@Controller('public/stores')
export class PublicStoresController {
    constructor(private readonly stores: StoresService) { }

    @Get('invitations/:token')
    @ApiOperation({ summary: 'Datos de una invitación (tienda, rol, quién invita y correo) para quien aún no tiene cuenta' })
    invitation(@Param('token') token: string) {
        return this.stores.describirInvitacion(token);
    }

    @Get(':token')
    @ApiOperation({ summary: 'Información general de una tienda por su enlace público (sin login)' })
    summary(@Param('token') token: string) {
        return this.stores.publicSummary(token);
    }
}
