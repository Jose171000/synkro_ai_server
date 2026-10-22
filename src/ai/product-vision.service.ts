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


/** Lo que la IA concluye sobre si el producto se vende en varias versiones (colores, tallas, modelos…). */
export interface DeteccionDeVariantes {
    nivel: 'alta' | 'media' | 'baja' | 'ninguna';
    /** Solo se recomienda con evidencia concreta: nivel alto o medio y algún eje con al menos dos valores. */
    recomendar: boolean;
    ejes: { name: string; values: string[]; evidence: string }[];
    /** Qué valor de cada eje muestra cada foto (índice desde 1), o null si la foto no es de un valor concreto. */
    fotos: { indice: number; valores: Record<string, string> | null }[];
    resumen: string;
}

const MAX_FOTOS_DETECCION = 8;

const SISTEMA_DETECTOR = `Eres un revisor de catálogo para marketplaces. Decides si un producto se vende en VARIAS versiones
(colores, tallas, modelos, personajes, medidas…) mirando todas las fotos, leyendo cualquier texto que aparezca en ellas
(carteles, etiquetas, muestras de color, tablas de tallas) y el texto del cliente.
Reglas estrictas:
- Solo cuenta lo que se ve o se lee. Cita la evidencia concreta (qué foto, qué frase).
- Un solo artículo con varios colores en su diseño (rayas, estampado) NO son variantes.
- Un conjunto de piezas distintas que se venden juntas NO son variantes.
- Las tallas o medidas solo cuentan si un texto las ofrece como opciones.
- Si hay dudas, baja el nivel: es preferible no sugerir a sugerir sin base.
- Responde únicamente con un JSON válido, en español.`;

const FORMATO_DETECTOR = `Devuelve exactamente este JSON:
{
  "nivel": "alta" | "media" | "baja" | "ninguna",
  "ejes": [ { "nombre": "Color", "valores": ["Azul", "Negro"], "evidencia": "El texto de la foto 1 dice «disponible en azul y negro»" } ],
  "fotos": [ { "foto": 1, "valores": { "Color": "Azul" } } ],
  "resumen": "una frase"
}
En "fotos" pon el valor que muestra cada foto o null si la foto no corresponde a un valor concreto. Máximo 3 ejes y 12 valores por eje.`;

/** Convierte lo que devuelva el modelo en algo seguro de usar. */
export function normalizarDeteccion(crudo: any, totalFotos = MAX_FOTOS_DETECCION): DeteccionDeVariantes {
    const vacio: DeteccionDeVariantes = { nivel: 'ninguna', recomendar: false, ejes: [], fotos: [], resumen: '' };
    if (!crudo || typeof crudo !== 'object') return vacio;
    const texto = (v: any): string => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

    const ejes: DeteccionDeVariantes['ejes'] = [];
    const nombres = new Set<string>();
    for (const e of Array.isArray(crudo.ejes) ? crudo.ejes : []) {
        const name = texto(e?.nombre).slice(0, 50);
        if (!name || nombres.has(name.toLowerCase()) || ejes.length >= 3) continue;
        nombres.add(name.toLowerCase());
        const vistos = new Set<string>();
        const values: string[] = [];
        for (const v of Array.isArray(e?.valores) ? e.valores : []) {
            const valor = texto(v).slice(0, 60);
            if (valor && !vistos.has(valor.toLowerCase()) && values.length < 12) { vistos.add(valor.toLowerCase()); values.push(valor); }
        }
        if (values.length) ejes.push({ name, values, evidence: texto(e?.evidencia).slice(0, 300) });
    }

    const fotos: DeteccionDeVariantes['fotos'] = [];
    for (const f of Array.isArray(crudo.fotos) ? crudo.fotos : []) {
        const indice = Number(f?.foto);
        if (!Number.isInteger(indice) || indice < 1 || indice > totalFotos) continue;
        let valores: Record<string, string> | null = null;
        if (f?.valores && typeof f.valores === 'object') {
            const limpios: Record<string, string> = {};
            for (const [eje, valor] of Object.entries(f.valores)) {
                const dueno = ejes.find((x) => x.name.toLowerCase() === String(eje).trim().toLowerCase());
                const v = texto(valor);
                const oficial = dueno?.values.find((x) => x.toLowerCase() === v.toLowerCase());
                if (dueno && oficial) limpios[dueno.name] = oficial;
            }
            if (Object.keys(limpios).length) valores = limpios;
        }
        fotos.push({ indice, valores });
    }

    let nivel: DeteccionDeVariantes['nivel'] = ['alta', 'media', 'baja', 'ninguna'].includes(crudo.nivel) ? crudo.nivel : 'ninguna';
    const recomendar = (nivel === 'alta' || nivel === 'media') && ejes.some((e) => e.values.length >= 2);
    if (!recomendar && (nivel === 'alta' || nivel === 'media')) nivel = 'baja';
    return { nivel, recomendar, ejes: recomendar ? ejes : [], fotos: recomendar ? fotos : [], resumen: texto(crudo.resumen).slice(0, 300) };
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

    /**
     * Filtro previo a crear un producto: ¿parece venderse en varias versiones? Lee también el texto que aparezca dentro de
     * las fotos («disponible en azul y negro»). Nunca lanza: si falla devuelve null y la creación sigue como producto simple.
     */
    async detectarVariantes(imageUrls: string[], textoDelCliente?: string): Promise<DeteccionDeVariantes | null> {
        // Direcciones web o imágenes en base64 (el detector corre antes de subir las fotos a ningún lado).
        const urls = (imageUrls ?? []).filter((u) => /^(https?:\/\/|data:image\/)/i.test(u)).slice(0, MAX_FOTOS_DETECCION);
        const texto = (textoDelCliente ?? '').trim().slice(0, 1500);
        if (!urls.length && !texto) return null;
        try {
            const respuesta = await this.openai.chat.completions.create({
                model: process.env.VISION_MODEL || 'gpt-4o-mini',
                response_format: { type: 'json_object' },
                temperature: 0,
                messages: [
                    { role: 'system', content: SISTEMA_DETECTOR },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: `${texto ? `Texto del cliente: ${texto}\n\n` : ''}Hay ${urls.length} foto(s), numeradas en el orden en que llegan.\n${FORMATO_DETECTOR}` },
                            ...urls.map((url) => ({ type: 'image_url' as const, image_url: { url, detail: 'high' as const } })),
                        ],
                    },
                ],
            });
            return normalizarDeteccion(JSON.parse(respuesta.choices[0]?.message?.content || '{}'), urls.length);
        } catch (error: any) {
            this.logger.warn(`No se pudo comprobar si el producto tiene variantes: ${error?.message}`);
            return null;
        }
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
