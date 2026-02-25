export const MARKETPLACE_PROMPT_RULES: Record<
    string,
    { instructions: string; jsonStructure: string }
> = {
    amazon: {
        instructions: `
      - REGLAS PARA AMAZON:
        - title: Máximo 200 caracteres. Usa palabras clave SEO relevantes para Amazon.
        - bullet_points: Genera exactamente 5 puntos clave destacando beneficios y usos principales.
        - description: Descripción estructurada, en formato de texto claro y persuasivo.
        - brand: Deduce la marca si es posible, o devuelve "Genérica".
    `,
        jsonStructure: `"amazon": { "title": "string", "bullet_points": ["string", "string", "string", "string", "string"], "description": "string", "brand": "string" }`,
    },
    mercadolibre: {
        instructions: `
      - REGLAS PARA MERCADO LIBRE:
        - title: Máximo 60 caracteres (CRÍTICO: no te pases de 60). Sin palabras clave de relleno.
        - condition: Debe ser exactamente "new" o "used". Asume "new" por defecto.
        - description: Texto plano, enfocado en garantías, envíos y detalles técnicos rápidos.
    `,
        jsonStructure: `"mercadolibre": { "title": "string", "condition": "string", "description": "string" }`,
    },
    shopify: {
        instructions: `
      - REGLAS PARA SHOPIFY:
        - title: Título atractivo para presentar en una tienda propia, amigable para el SEO general.
        - tags: Array de 5 a 10 etiquetas, separadas por comas, relevantes para clasificar en e-commerce (ej. "calzado, running, nike").
        - meta_description: Máximo 160 caracteres, ideal para destacar en resultados de búsqueda de Google.
        - html_description: Descripción completa utilizando formato HTML básico (<b>, <p>, <ul>).
    `,
        jsonStructure: `"shopify": { "title": "string", "tags": ["string"], "meta_description": "string", "html_description": "string" }`,
    },
};
