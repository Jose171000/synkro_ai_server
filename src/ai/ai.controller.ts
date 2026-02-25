import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AiService } from './ai.service';
import { GenerateListingsDto } from './dto/generate-listings.dto';
import { ApiStandardResponse } from '../common/decorators/api-standard-response.decorator';

@ApiTags('ai')
@Controller('ai')
export class AiController {
    constructor(private readonly aiService: AiService) { }

    @Post('preview-prompt')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Preview the dynamically generated AI Prompt',
        description: 'Recibe datos de un producto y marketplaces destino, devolviendo el prompt final unificado (sin llamar aún a OpenAI). Útil para depuración.',
    })
    @ApiResponse({
        status: 200,
        description: 'El string del prompt consolidado listo para enviar a GPT.',
    })
    previewDynamicPrompt(@Body() dto: GenerateListingsDto) {
        const prompt = this.aiService.buildDynamicPrompt(dto);
        return { promptPreview: prompt };
    }

    @Post('preview-categorization')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Preview the dynamically generated AI Categorization Prompt (Phase A)',
        description: 'Recibe datos básicos de un producto y devuelve el prompt que obliga al LLM a elegir los IDs de categoría correctos de nuestro árbol predefinido.',
    })
    @ApiResponse({
        status: 200,
        description: 'El string del prompt de categorización listo para enviar a GPT.',
    })
    previewCategorizationPrompt(@Body() dto: GenerateListingsDto) {
        const prompt = this.aiService.buildCategorizationPrompt(
            dto.productName,
            dto.description,
            dto.targetMarketplaces,
        );
        return { promptPreview: prompt };
    }
}
