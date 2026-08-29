import {
    Body,
    Controller,
    ConflictException,
    Delete,
    Get,
    NotFoundException,
    Param,
    Patch,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { FalabellaCategoryImportService } from './falabella-category-import.service';
import { CategorySeederService } from './category-seeder.service';
import { AddCategoryDto } from './dto/add-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { MarketplaceCategory } from './entities/marketplace-category.entity';
import { Repository } from 'typeorm';

@ApiTags('categories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('categories')
export class CategoryController {
    constructor(
        private readonly falabellaImport: FalabellaCategoryImportService,
        private readonly categorySeederService: CategorySeederService,
        @InjectRepository(MarketplaceCategory)
        private readonly categoryRepository: Repository<MarketplaceCategory>,
    ) { }

    /** [ADMIN] Add a new category — generates embedding via OpenAI */
    @Post('falabella/import')
    @Roles(UserRole.ADMIN)
    @ApiOperation({
        summary: 'Trae las categorías de Falabella para que la IA pueda elegirlas',
        description:
            'Descarga el árbol completo de Falabella y guarda cada categoría con su vector semántico. ' +
            'Sin esto la IA no propone categoría de Falabella y hay que ponerla a mano en cada producto. ' +
            'Se puede repetir: las que ya existen se actualizan.',
    })
    importFalabellaCategories(@Req() req) {
        return this.falabellaImport.importCategories(req.user.id);
    }

    @Post()
    @Roles(UserRole.ADMIN)
    @ApiOperation({
        summary: '[ADMIN] Agregar una nueva categoría de marketplace',
        description: 'Crea una nueva categoría y genera su embedding semántico vía OpenAI.',
    })
    async addCategory(@Body() dto: AddCategoryDto) {
        const existing = await this.categoryRepository.findOne({
            where: { categoryId: dto.categoryId, marketplace: dto.marketplace.toLowerCase() },
        });
        if (existing) {
            throw new ConflictException(
                `La categoría con ID "${dto.categoryId}" ya existe para el marketplace "${dto.marketplace}".`
            );
        }

        const embedding = await this.categorySeederService.generateEmbedding(dto.labelText);
        const category = this.categoryRepository.create({
            ...dto,
            marketplace: dto.marketplace.toLowerCase(),
            embedding,
        });

        const saved = await this.categoryRepository.save(category);
        return {
            message: `Categoría "${saved.name}" creada exitosamente para ${saved.marketplace}.`,
            category: saved,
        };
    }

    /** [ADMIN] List all categories */
    @Get()
    @Roles(UserRole.ADMIN)
    @ApiOperation({ summary: '[ADMIN] Listar todas las categorías de marketplace' })
    async listCategories() {
        return this.categoryRepository.find({ order: { marketplace: 'ASC', name: 'ASC' } });
    }

    /** [ADMIN] Edit a category — regenerates embedding if labelText or requiredAttributes change */
    @Patch(':id')
    @Roles(UserRole.ADMIN)
    @ApiOperation({
        summary: '[ADMIN] Editar una categoría existente',
        description: 'Actualiza los campos de la categoría. Si se modifica `labelText`, el embedding se regenera automáticamente vía OpenAI.',
    })
    async updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
        const category = await this.categoryRepository.findOne({ where: { id } });
        if (!category) {
            throw new NotFoundException(`Categoría con ID "${id}" no encontrada.`);
        }

        // Update editable fields
        if (dto.name !== undefined) category.name = dto.name;
        if (dto.requiredAttributes !== undefined) category.requiredAttributes = dto.requiredAttributes;

        // Regenerate embedding only if labelText changed
        if (dto.labelText !== undefined && dto.labelText !== category.labelText) {
            category.labelText = dto.labelText;
            category.embedding = await this.categorySeederService.generateEmbedding(dto.labelText);
        }

        const updated = await this.categoryRepository.save(category);
        return {
            message: `Categoría "${updated.name}" actualizada correctamente.`,
            regeneratedEmbedding: dto.labelText !== undefined && dto.labelText !== category.labelText,
            category: updated,
        };
    }

    /** [ADMIN] Delete a category by UUID */
    @Delete(':id')
    @Roles(UserRole.ADMIN)
    @ApiOperation({ summary: '[ADMIN] Eliminar una categoría por ID' })
    async deleteCategory(@Param('id') id: string) {
        const category = await this.categoryRepository.findOne({ where: { id } });
        if (!category) {
            throw new NotFoundException(`Categoría con ID "${id}" no encontrada.`);
        }
        await this.categoryRepository.remove(category);
        return { message: `Categoría "${category.name}" eliminada exitosamente.` };
    }
}
