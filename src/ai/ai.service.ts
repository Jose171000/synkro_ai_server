import { Injectable, BadRequestException } from '@nestjs/common';
import { GenerateListingsDto } from './dto/generate-listings.dto';
import { MARKETPLACE_PROMPT_RULES } from './marketplace.constants';
import { MOCK_CATEGORY_TREE } from './marketplace-categories.constants';

@Injectable()
export class AiService {

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
