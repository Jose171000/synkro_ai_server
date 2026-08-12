import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { CrmService } from './crm.service';
import { CreateLeadDto, ImportLeadsDto, UpdateLeadDto } from './dto/lead.dto';

@ApiTags('crm')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('crm')
export class CrmController {
    constructor(private readonly crmService: CrmService) { }

    @Get('leads')
    @ApiOperation({ summary: 'Lista los prospectos, con búsqueda y filtro por etapa' })
    @ApiQuery({ name: 'search', required: false })
    @ApiQuery({ name: 'stage', required: false })
    findAll(@Query('search') search?: string, @Query('stage') stage?: string) {
        return this.crmService.findAll(search, stage);
    }

    @Get('summary')
    @ApiOperation({ summary: 'Resumen del embudo: cantidad y valor por etapa' })
    getSummary() {
        return this.crmService.getSummary();
    }

    @Post('leads')
    @ApiOperation({ summary: 'Crea un prospecto' })
    create(@Body() dto: CreateLeadDto) {
        return this.crmService.create(dto);
    }

    @Patch('leads/:id')
    @ApiOperation({ summary: 'Actualiza un prospecto (incluye mover de etapa)' })
    update(@Param('id') id: string, @Body() dto: UpdateLeadDto) {
        return this.crmService.update(id, dto);
    }

    @Delete('leads/:id')
    @ApiOperation({ summary: 'Elimina un prospecto' })
    remove(@Param('id') id: string) {
        return this.crmService.remove(id);
    }

    @Post('import')
    @ApiOperation({
        summary: 'Importa prospectos desde un Google Sheet publicado como CSV',
        description:
            'Detecta las columnas automáticamente (nombre, empresa, correo, teléfono, estado, origen, valor, notas, fecha). ' +
            'Con dryRun=true solo devuelve la vista previa sin guardar. Los prospectos existentes se actualizan en vez de duplicarse.',
    })
    import(@Body() dto: ImportLeadsDto) {
        return this.crmService.importFromCsv(dto.csvUrl, dto.dryRun === true);
    }
}
