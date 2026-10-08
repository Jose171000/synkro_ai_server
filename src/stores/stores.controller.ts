import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AcceptInvitationDto, ChangeRoleDto, CreateStoreDto, InviteDto, PublicLinkDto } from './dto/store.dto';
import { StoresService } from './stores.service';

@ApiTags('stores')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stores')
export class StoresController {
    constructor(private readonly stores: StoresService) { }

    @Post()
    @ApiOperation({ summary: 'Crea una tienda; quien la crea queda como dueño' })
    create(@Body() dto: CreateStoreDto, @Req() req) {
        return this.stores.create(req.user.id, dto.name);
    }

    @Get()
    @ApiOperation({ summary: 'Tiendas a las que el usuario tiene acceso (selector de tiendas)' })
    listMine(@Req() req) {
        return this.stores.listMine(req.user.id);
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
        return this.stores.changeRole(req.user.id, storeId, userId, dto.role);
    }

    @Delete(':storeId/members/:userId')
    @ApiOperation({ summary: 'Quita a un miembro de la tienda (solo el dueño)' })
    removeMember(@Param('storeId') storeId: string, @Param('userId') userId: string, @Req() req) {
        return this.stores.removeMember(req.user.id, storeId, userId);
    }

    @Post(':storeId/invitations')
    @ApiOperation({ summary: 'Invita por correo a una persona a la tienda (solo el dueño)' })
    invite(@Param('storeId') storeId: string, @Body() dto: InviteDto, @Req() req) {
        return this.stores.invite(req.user.id, storeId, dto.email, dto.role);
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

    @Get(':token')
    @ApiOperation({ summary: 'Información general de una tienda por su enlace público (sin login)' })
    summary(@Param('token') token: string) {
        return this.stores.publicSummary(token);
    }
}
