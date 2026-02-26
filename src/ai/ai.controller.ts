import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
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
    @ApiBody({
        type: GenerateListingsDto,
        examples: {
            basic: {
                summary: 'Ejemplo completo con requerimientos dinámicos',
                value: {
                    productName: "Zapatillas deportivas para running",
                    description: "Son de color rojo, con suela ultra ligera y cordones ajustables.",
                    targetMarketplaces: ["amazon", "mercadolibre"],
                    extractedAttributes: { "marca": "Nike", "coleccion": "2026" },
                    categoryRequirements: {
                        amazon: ["ShoeSize", "OuterMaterialType", "DepartmentName"],
                        mercadolibre: ["Material del interior", "Género"]
                    }
                }
            }
        }
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
    @ApiBody({
        type: GenerateListingsDto,
        examples: {
            basic: {
                summary: 'Ejemplo básico de envío para obtener prompt de categorización',
                value: {
                    productName: "Zapatillas deportivas para running",
                    description: "Son de color rojo, con suela ultra ligera y cordones ajustables.",
                    targetMarketplaces: ["amazon", "mercadolibre"]
                }
            }
        }
    })
    previewCategorizationPrompt(@Body() dto: GenerateListingsDto) {
        const prompt = this.aiService.buildCategorizationPrompt(
            dto.productName,
            dto.description,
            dto.targetMarketplaces,
        );
        return { promptPreview: prompt };
    }

    @Post('generate-listings')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'EXECUTE FULL AI PIPELINE (Phase A + Phase B)',
        description: 'Generates final JSON listings communicating directly with DeepSeek API.',
    })
    @ApiResponse({
        status: 200,
        description: 'The final generated JSON ready for DB insertion.',
    })
    @ApiBody({
        type: GenerateListingsDto,
        examples: {
            basic: {
                summary: 'Carga de prueba real hacia la API',
                value: {
                    productName: "Iphone 15 Pro Max",
                    description: "Celular apple color titanium blue con 256GB de almacenamiento.",
                    targetMarketplaces: ["amazon", "mercadolibre"]
                }
            }
        }
    })
    async generateListings(@Body() dto: GenerateListingsDto) {
        const result = await this.aiService.generateProductContent({
            name: dto.productName,
            description: dto.description,
            targetMarketplaces: dto.targetMarketplaces
        });
        return { data: result };
    }
}
