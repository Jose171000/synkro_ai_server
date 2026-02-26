import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { GenerateListingsDto } from './dto/generate-listings.dto';
import { MARKETPLACE_PROMPT_RULES } from './marketplace.constants';
import { MOCK_CATEGORY_TREE } from './marketplace-categories.constants';
import OpenAI from 'openai';

@Injectable()
@Injectable()
export class AiService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
  }

  /**
   * ORCHESTRATOR: generateProductContent
   * Orchestrates Phase A and Phase B to generate the final listings using DeepSeek.
   */
  public async generateProductContent(dto: { name: string, description: string, category?: string, subcategory?: string, targetMarketplaces: string[], tone?: string }) {
    // 1. PHASE A: Ask DeepSeek to categorize the product
    const categorizationPrompt = this.buildCategorizationPrompt(dto.name, dto.description, dto.targetMarketplaces);

    let categoryRequirements: Record<string, string[]> = {};
    let catJson: any = {};

    try {
      const catResponse = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an AI that STRICTLY outputs valid JSON arrays and objects only.' },
          { role: 'user', content: categorizationPrompt }
        ]
      });

      catJson = JSON.parse(catResponse.choices[0].message.content || '{}');

      // Extract the required attributes from our MOCK_CATEGORY_TREE based on what the AI decided
      dto.targetMarketplaces.forEach(marketplace => {
        const electedId = catJson[`${marketplace.toLowerCase()}_category_id`];
        const treeNodes = MOCK_CATEGORY_TREE[marketplace.toLowerCase()];

        if (treeNodes && electedId) {
          // Find the subcategory that matches the ID chosen by DeepSeek
          for (const mainCat of treeNodes) {
            const sub = mainCat.subcategories.find(s => s.id === electedId);
            if (sub) {
              categoryRequirements[marketplace.toLowerCase()] = sub.requiredAttributes;
              break;
            }
          }
        }
      });

    } catch (error) {
      console.error('[AiService] Failed during Phase A Categorization:', error);
      // Fallback: If category extraction fails, we just send empty requirements instead of crashing
      categoryRequirements = {};
    }

    // 2. PHASE B: Construct and send the final prompt using the discovered requirements
    const generatorDto: GenerateListingsDto = {
      productName: dto.name,
      description: dto.description,
      targetMarketplaces: dto.targetMarketplaces,
      categoryRequirements
    };

    const generationPrompt = this.buildDynamicPrompt(generatorDto);

    try {
      const finalResponse = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an AI that STRICTLY outputs valid JSON only.' },
          { role: 'user', content: generationPrompt }
        ]
      });

      const finalJson = JSON.parse(finalResponse.choices[0].message.content || '{}');

      // Bundle the results from Phase A (Categorization) and Phase B (Generation) together
      return {
        categorizedAs: catJson,
        generatedListings: finalJson
      };

    } catch (error) {
      console.error('[AiService] Failed during Phase B Generation:', error);
      throw new InternalServerErrorException('Failed to generate product content via AI.');
    }
  }

  /**
   * PHASE A: The Categorizer
   * Builds a prompt asking the LLM to read the product and map it to our known Category IDs.
   */
  public buildCategorizationPrompt(productName: string, description: string, targetMarketplaces: string[]): string {
    if (!targetMarketplaces || targetMarketplaces.length === 0) {
      throw new BadRequestException('At least one target marketplace must be specified.');
    }

    let prompt = `
Eres un experto clasificador de catálogo e-commerce.
Tu tarea es analizar el siguiente producto y asignarle la categoría MÁS ADECUADA dentro de nuestro árbol de categorías predefinido para cada marketplace solititado.

**PRODUCTO:**
- Nombre: ${productName}
- Descripción: ${description}

**ÁRBOL DE CATEGORÍAS DISPONIBLE:**
`;

    // Inyectar solo las subcategorías de los marketplaces solicitados
    let jsonStructureExpected = '';

    targetMarketplaces.forEach((marketplace, index) => {
      const tree = MOCK_CATEGORY_TREE[marketplace.toLowerCase()];
      if (tree) {
        prompt += `\n--- TARGET MARKETPLACE: ${marketplace.toUpperCase()} ---\n`;
        tree.forEach((mainCat) => {
          prompt += `Familia: ${mainCat.name}\n`;
          mainCat.subcategories.forEach((sub) => {
            prompt += `  ID: "${sub.id}" -> Nombre: ${sub.name}\n`;
          });
        });

        jsonStructureExpected += `"${marketplace.toLowerCase()}_category_id": "STRING_ID"`;
        if (index < targetMarketplaces.length - 1) jsonStructureExpected += ', ';
      }
    });

    prompt += `
--------------------------------------------------------------------------------------
**== FORMATO EXACTO DE RESPUESTA ==**
Debes devolver ÚNICA Y OBLIGATORIAMENTE un JSON válido con los IDs exactos que elegiste (no inventes IDs que no estén en la lista de arriba):

{
  ${jsonStructureExpected}
}
`;

    return prompt;
  }

  /**
   * PHASE B: The Generator
   * Generates the dynamic prompt string by aggregating rules based on the user's selected marketplaces.
   */
  public buildDynamicPrompt(dto: GenerateListingsDto): string {
    const { productName, description, targetMarketplaces, extractedAttributes, categoryRequirements } = dto;

    if (!targetMarketplaces || targetMarketplaces.length === 0) {
      throw new BadRequestException('At least one target marketplace must be specified.');
    }

    // 1. Empezamos con el "Core" (Contexto principal)
    let finalPrompt = `
Eres un experto redactor Copywriter de e - commerce y especialista en SEO para venta multicanal.
Tu tarea es tomar la siguiente información de un producto base y generar el contenido optimizado
estrictamente adaptado a las reglas de los lugares donde se va a publicar.

** PRODUCTO BASE:**
      - Nombre: ${productName}
    - Descripción del usuario: ${description}
${extractedAttributes ? '- Atributos extraídos: ' + JSON.stringify(extractedAttributes) : ''}
    `;

    // 2. Variables para acumular las reglas
    let dynamicInstructions = '';
    let dynamicJsonStructure = '';

    // 3. Iteramos por cada marketplace válido que nos enviaron
    let isFirst = true;

    for (const marketplace of targetMarketplaces) {
      const rules = MARKETPLACE_PROMPT_RULES[marketplace.toLowerCase()];

      if (rules) {
        // Obtenemos los requerimientos dinámicos de la categoría (si nos mandaron alguno para este marketplace)
        const reqsForMarketplace = categoryRequirements?.[marketplace.toLowerCase()];

        if (reqsForMarketplace && reqsForMarketplace.length > 0) {
          dynamicInstructions += rules.instructions + `
      - REQUERIMIENTOS OBLIGATORIOS DE CATEGORÍA:
    ATENCIÓN: Debes inferir de los datos extraídos y devolver estructurados OBLIGATORIAMENTE los siguientes atributos: ${reqsForMarketplace.join(', ')}.
    `;

          // Construimos dinámicamente el objeto "attributes" en el JSON
          const dynamicAttributesKeys = reqsForMarketplace.map(req => `"${req}": "string"`).join(', ');

          // Inyectamos el nodo "attributes" justo antes de cerrar la llave final del esquema de este marketplace
          const modifiedJsonStructure = rules.jsonStructure.replace(
            /\}$/,
            `, "attributes": { ${dynamicAttributesKeys} }
  }`
          );

          if (isFirst) {
            dynamicJsonStructure += modifiedJsonStructure;
            isFirst = false;
          } else {
            dynamicJsonStructure += ',\n      ' + modifiedJsonStructure;
          }

        } else {
          // Si no hay requerimientos dinámicos, inyectamos las reglas base
          dynamicInstructions += rules.instructions + '\n';

          if (isFirst) {
            dynamicJsonStructure += rules.jsonStructure;
            isFirst = false;
          } else {
            dynamicJsonStructure += ',\n      ' + rules.jsonStructure;
          }
        }
      } else {
        // Opcional: Podrías hacer un throw de BadRequest si manda un marketplace no soportado
        console.warn(`[AiService] Marketplace '${marketplace}' not found in constants.`);
      }
    }

    // 4. Armamos el footer con exigencias del formato de salida
    finalPrompt += `
--------------------------------------------------------------------------------------
** AQUÍ ESTÁN LAS REGLAS ESTRICTAS PARA CADA MARKETPLACE SOLICITADO:**
  ${dynamicInstructions}

**== FORMATO EXACTO DE RESPUESTA ==**
  Debes devolver ÚNICA Y OBLIGATORIAMENTE un JSON válido(sin etiquetas markdown \`\`\`json ni texto extra fuera de las llaves)
con esta estructura exacta:
{
  ${dynamicJsonStructure}
}
    `;

    return finalPrompt;
  }
}
