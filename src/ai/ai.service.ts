import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface GenerateContentInput {
  name: string;
  description: string;
  category?: string;
  subcategory?: string;
  targetMarketplaces?: string[];
  tone?: string;
}

interface GeneratedContent {
  title: string;
  description: string;
  keywords: string[];
  attributes: Record<string, any>;
}

@Injectable()
export class AIService {
  private apiKey: string;
  private apiUrl: string;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('OPENAI_API_KEY') || '';
    this.apiUrl = 'https://api.openai.com/v1/chat/completions';
  }

  async generateProductContent(input: GenerateContentInput): Promise<GeneratedContent> {
    const prompt = this.buildPrompt(input);

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Eres un experto en SEO y copywriting para ecommerce. 
                      Generas contenido optimizado para marketplaces como MercadoLibre, Amazon y Shopify.
                      Responde SIEMPRE en formato JSON válido.`,
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
      }),
    });

    const data = await response.json();
    const content = JSON.parse(data.choices[0].message.content);

    return {
      title: content.title,
      description: content.description,
      keywords: content.keywords || [],
      attributes: content.attributes || {},
    };
  }

  private buildPrompt(input: GenerateContentInput): string {
    const marketplacesText = input.targetMarketplaces?.join(', ') || 'general';
    
    return `
      Genera contenido optimizado para un producto de ecommerce.
      
      **Información del producto:**
      - Nombre: ${input.name}
      - Descripción original: ${input.description}
      - Categoría: ${input.category || 'No especificada'}
      - Subcategoría: ${input.subcategory || 'No especificada'}
      - Marketplaces destino: ${marketplacesText}
      - Tono: ${input.tone || 'profesional'}
      
      **Genera:**
      1. Un título SEO optimizado (máx 80 caracteres)
      2. Una descripción atractiva y persuasiva (200-400 palabras)
      3. 10 keywords relevantes
      4. Atributos sugeridos según la categoría
      
      Responde en este formato JSON:
      {
        "title": "...",
        "description": "...",
        "keywords": ["...", "..."],
        "attributes": {
          "marca": "...",
          "material": "...",
          ...
        }
      }
    `;
  }
}
