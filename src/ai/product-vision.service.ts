import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

/** Lo que la IA puede ver en las fotos de un producto. */
export interface ProductVision {
    /** Qué es, en pocas palabras: «juego de sábanas», «zapatillas running». */
    productType: string;
    /** Título comercial sugerido, en español. */
    suggestedName: string;
    /** Descripción corta basada solo en lo que se ve. */
    description: string;
    brand: string | null;
    color: string | null;
    material: string | null;
    /** Hombre, mujer, niños, unisex… si se deduce. */
    gender: string | null;
    /** Palabras clave para buscar la categoría. */
    keywords: string[];
    /** Otros datos visibles (estampado, cantidad de piezas, texto del empaque…). */
    attributes: Record<string, string>;
    /** 0 a 1: qué tan segura está la IA de lo que identificó. */
    confidence: number;
}

const MAX_IMAGES = 4;

const SYSTEM = `Eres un catalogador experto de productos para marketplaces de Latinoamérica.
Observas las fotos de un producto y describes SOLO lo que se ve o se lee en ellas (etiquetas, empaque, logos).
Reglas estrictas:
- No inventes datos. Si algo no se ve o no se puede deducir, devuelve null.
- La marca solo si aparece escrita o es inconfundible.
- Responde únicamente con un JSON válido, en español.`;

const FORMATO = `Devuelve exactamente este JSON:
{
  "productType": "string",
  "suggestedName": "string (título comercial claro, sin mayúsculas sostenidas)",
  "description": "string (2-3 frases con lo que se ve)",
  "brand": "string o null",
  "color": "string o null",
  "material": "string o null",
  "gender": "string o null",
  "keywords": ["string"],
  "attributes": { "nombre del dato": "valor" },
  "confidence": 0.0
}`;

/** Convierte lo que devuelva el modelo en algo seguro de usar. */
export function normalizarVision(crudo: any): ProductVision | null {
    if (!crudo || typeof crudo !== 'object') return null;
    const texto = (v: any): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const productType = texto(crudo.productType);
    const suggestedName = texto(crudo.suggestedName);
    if (!productType && !suggestedName) return null;

    const attributes: Record<string, string> = {};
    if (crudo.attributes && typeof crudo.attributes === 'object') {
        for (const [k, v] of Object.entries(crudo.attributes)) {
            const valor = texto(v);
            if (valor && k.trim()) attributes[k.trim()] = valor;
        }
    }
    const confianza = Number(crudo.confidence);

    return {
        productType: productType ?? suggestedName!,
        suggestedName: suggestedName ?? productType!,
        description: texto(crudo.description) ?? '',
        brand: texto(crudo.brand),
        color: texto(crudo.color),
        material: texto(crudo.material),
        gender: texto(crudo.gender),
        keywords: Array.isArray(crudo.keywords) ? crudo.keywords.map(texto).filter(Boolean) as string[] : [],
        attributes,
        confidence: Number.isFinite(confianza) ? Math.min(Math.max(confianza, 0), 1) : 0,
    };
}

/**
 * Mira las fotos del producto y extrae lo que el cliente no escribió.
 * Nunca lanza: si falla, el flujo sigue con lo que el cliente haya escrito.
 */
@Injectable()
export class ProductVisionService {
    private readonly logger = new Logger(ProductVisionService.name);
    private client: OpenAI | null = null;

    private get openai(): OpenAI {
        if (!this.client) this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        return this.client;
    }

    async analyze(imageUrls: string[], hint?: { name?: string; description?: string }): Promise<ProductVision | null> {
        const urls = (imageUrls ?? []).filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_IMAGES);
        if (!urls.length) return null;

        const contexto = [hint?.name && `Nombre indicado por el cliente: ${hint.name}`, hint?.description && `Descripción del cliente: ${hint.description}`]
            .filter(Boolean)
            .join('\n');

        try {
            const respuesta = await this.openai.chat.completions.create({
                model: process.env.VISION_MODEL || 'gpt-4o-mini',
                response_format: { type: 'json_object' },
                temperature: 0.2,
                messages: [
                    { role: 'system', content: SYSTEM },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: `${contexto ? contexto + '\n\n' : ''}Analiza las fotos de este producto.\n${FORMATO}` },
                            ...urls.map((url) => ({ type: 'image_url' as const, image_url: { url, detail: 'low' as const } })),
                        ],
                    },
                ],
            });
            return normalizarVision(JSON.parse(respuesta.choices[0]?.message?.content || '{}'));
        } catch (error: any) {
            this.logger.warn(`No se pudieron analizar las fotos: ${error?.message}`);
            return null;
        }
    }
}
