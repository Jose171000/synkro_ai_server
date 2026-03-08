import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { GenerateListingsDto } from './dto/generate-listings.dto';
import { MARKETPLACE_PROMPT_RULES } from './marketplace.constants';
import { VectorSearchService } from '../categories/vector-search.service';
import { CategorySeederService } from '../categories/category-seeder.service';
import { MarketplaceCategory, CategoryAttribute } from '../categories/entities/marketplace-category.entity';
import OpenAI from 'openai';

@Injectable()
export class AiService {
  private openai: OpenAI;

  constructor(
    private readonly vectorSearchService: VectorSearchService,
    private readonly categorySeederService: CategorySeederService,
  ) {
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
    let categoryRequirements: Record<string, CategoryAttribute[]> = {};
    let catJson: any = {};

    try {
      // PHASE A: Vector Search + LLM Categorization
      // Step 1: Get the embedding for the product text
      const productText = `${dto.name} ${dto.description}`;
      const productEmbedding = await this.categorySeederService.generateEmbedding(productText);

      // Step 2: For each marketplace, find the top 5 most semantically similar categories
      const categoriesPerMarketplace: Record<string, MarketplaceCategory[]> = {};
      for (const marketplace of dto.targetMarketplaces) {
        const topCategories = await this.vectorSearchService.findSimilarCategories(
          productEmbedding,
          marketplace,
          5,
        );
        categoriesPerMarketplace[marketplace.toLowerCase()] = topCategories;
      }

      // Step 3: Build the categorization prompt with only the relevant top-5 categories
      const categorizationPrompt = this.buildCategorizationPrompt(
        dto.name,
        dto.description,
        dto.targetMarketplaces,
        categoriesPerMarketplace,
      );

      const catResponse = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an AI that STRICTLY outputs valid JSON arrays and objects only.' },
          { role: 'user', content: categorizationPrompt }
        ]
      });

      catJson = JSON.parse(catResponse.choices[0].message.content || '{}');

      // Step 4: Extract requiredAttributes from the matched category objects (already in memory)
      dto.targetMarketplaces.forEach(marketplace => {
        const electedId = catJson[`${marketplace.toLowerCase()}_category_id`];
        const topCats = categoriesPerMarketplace[marketplace.toLowerCase()] || [];
        const matched = topCats.find(c => c.categoryId === electedId);
        if (matched?.requiredAttributes) {
          categoryRequirements[marketplace.toLowerCase()] = matched.requiredAttributes;
        }
      });

    } catch (error) {
      console.error('[AiService] Failed during Phase A Categorization:', error);
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
  public buildCategorizationPrompt(
    productName: string,
    description: string,
    targetMarketplaces: string[],
    categoriesPerMarketplace: Record<string, MarketplaceCategory[]>,
  ): string {
    if (!targetMarketplaces || targetMarketplaces.length === 0) {
      throw new BadRequestException('At least one target marketplace must be specified.');
    }

    let prompt = `
Eres un experto clasificador de catálogo e-commerce.
Tu tarea es analizar el siguiente producto y asignarle la categoría MÁS ADECUADA de la lista pre-seleccionada para cada marketplace.
Las categorías ya fueron pre-filtradas semánticamente, elige la que mejor encaje.

**PRODUCTO:**
- Nombre: ${productName}
- Descripción: ${description}

**CATEGORÍAS CANDIDATAS (pre-filtradas por similitud semántica):**
`;

    let jsonStructureExpected = '';

    targetMarketplaces.forEach((marketplace) => {
      const candidates = categoriesPerMarketplace[marketplace.toLowerCase()] || [];
      if (candidates.length > 0) {
        prompt += `\n--- TARGET MARKETPLACE: ${marketplace.toUpperCase()} ---\n`;
        candidates.forEach((cat) => {
          prompt += `  ID: "${cat.categoryId}" -> Nombre: ${cat.name}\n`;
        });
        jsonStructureExpected += `  "${marketplace.toLowerCase()}_category_id": "<ID_elegido_de_la_lista_de_${marketplace}>",\n`;
      }
    });

    prompt += `
**INSTRUCCIÓN:**
Responde ÚNICAMENTE con un objeto JSON con esta estructura exacta:
{
${jsonStructureExpected}}

Elige el ID de categoría más apropiado de la lista. Si ninguna encaja, elige el más cercano.
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
          const required = reqsForMarketplace.filter((a: CategoryAttribute) => a.isRequired);
          const optional = reqsForMarketplace.filter((a: CategoryAttribute) => !a.isRequired);

          // Build structured attribute blocks for the LLM
          let attributeBlock = '';
          if (required.length > 0) {
            attributeBlock += `\n    [OBLIGATORIOS — DEBES completar estos campos sin excepción]:\n`;
            attributeBlock += required.map((a: CategoryAttribute) =>
              `      • "${a.name}": ${a.description} (ejemplo: "${a.example}")`
            ).join('\n');
          }
          if (optional.length > 0) {
            attributeBlock += `\n    [OPCIONALES — completa si puedes inferirlos del producto]:\n`;
            attributeBlock += optional.map((a: CategoryAttribute) =>
              `      ◦ "${a.name}": ${a.description} (ejemplo: "${a.example}")`
            ).join('\n');
          }

          dynamicInstructions += rules.instructions + `
      - ATRIBUTOS DE CATEGORÍA:${attributeBlock}
    `;

          // Build JSON schema: required attrs always included, optional marked with nullable hint
          const requiredKeys = required.map((a: CategoryAttribute) => `"${a.name}": "${a.example}"`).join(', ');
          const optionalKeys = optional.map((a: CategoryAttribute) => `"${a.name}": "${a.example} (opcional)"`).join(', ');
          const allKeys = [requiredKeys, optionalKeys].filter(Boolean).join(', ');
          const dynamicAttributesKeys = allKeys;

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
