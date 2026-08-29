import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSection, SectionAccessGuard } from '../common/guards/section-access.guard';
import { UserRole } from '../users/user-role';
import { CrmService } from './crm.service';
import { YavendioImportService } from './yavendio-import.service';
import { ImportYavendioDto } from './dto/import-yavendio.dto';
import { CreateLeadDto, ImportLeadsDto, UpdateLeadDto } from './dto/lead.dto';

@ApiTags('crm')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SectionAccessGuard)
@RequireSection('crm')
@Controller('crm')
export class CrmController {
    constructor(
        private readonly yavendioImport: YavendioImportService,private readonly crmService: CrmService) { }

    @Get('leads')
    @ApiOperation({ summary: 'Lista los prospectos, con búsqueda y filtro por etapa' })
    @ApiQuery({ name: 'search', required: false })
    @ApiQuery({ name: 'stage', required: false })
    findAll(@Req() req, @Query('search') search?: string, @Query('stage') stage?: string) {
        return this.crmService.findAll(req.user.id, search, stage);
    }

    @Get('summary')
    @ApiOperation({ summary: 'Resumen del embudo: cantidad y valor por etapa' })
    getSummary(@Req() req) {
        return this.crmService.getSummary(req.user.id);
    }

    @Post('leads')
    @ApiOperation({ summary: 'Crea un prospecto' })
    create(@Body() dto: CreateLeadDto, @Req() req) {
        return this.crmService.create(req.user.id, dto);
    }

    @Patch('leads/:id')
    @ApiOperation({ summary: 'Actualiza un prospecto (incluye mover de etapa)' })
    update(@Param('id') id: string, @Body() dto: UpdateLeadDto, @Req() req) {
        return this.crmService.update(req.user.id, id, dto);
    }

    @Delete('leads/:id')
    @ApiOperation({ summary: 'Elimina un prospecto' })
    remove(@Param('id') id: string, @Req() req) {
        return this.crmService.remove(req.user.id, id);
    }

    @Post('import')
    @ApiOperation({
        summary: 'Importa prospectos desde un Google Sheet publicado como CSV',
        description:
            'Detecta las columnas automáticamente (nombre, empresa, correo, teléfono, estado, origen, valor, notas, fecha). ' +
            'Con dryRun=true solo devuelve la vista previa sin guardar. Los prospectos existentes se actualizan en vez de duplicarse.',
    })
    import(@Body() dto: ImportLeadsDto, @Req() req) {
        return this.crmService.importFromCsv(req.user.id, dto.csvUrl, dto.dryRun === true);
    }

    @Post('import/yavendio')
    @ApiOperation({
        summary: 'Importa las conversaciones de Yavendió al embudo',
        description:
            'Usa la cuenta de Yavendió conectada por el administrador. Cada conversación se convierte en un prospecto: ' +
            'las ventas confirmadas entran como ganado/perdido, las que tienen mensajes como contactado y las que ' +
            'nunca tuvieron uno como nuevo. Con dryRun=true solo devuelve el conteo sin guardar, y con skipEmpty=true ' +
            'deja fuera las conversaciones sin ningún mensaje. Nunca revierte una etapa movida a mano.',
    })
    importYavendio(@Body() dto: ImportYavendioDto, @Req() req) {
        return this.yavendioImport.import(req.user.id, {
            dryRun: dto.dryRun === true,
            skipEmpty: dto.skipEmpty === true,
        });
    }
}
