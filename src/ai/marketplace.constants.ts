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
    falabella: {
        instructions: `
      - REGLAS PARA FALABELLA:
        - name: Máximo 200 caracteres. Empieza por el tipo de producto, luego marca y características
          que lo distingan (modelo, capacidad, talla, color). Sin mayúsculas sostenidas ni signos de
          exclamación: Falabella rechaza los títulos promocionales.
        - description: Mínimo 6 caracteres y máximo 25.000. Admite HTML sencillo (<p>, <ul>, <li>, <b>).
          Describe materiales, medidas, contenido del paquete y usos. Sin datos de contacto, precios
          ni menciones a otras tiendas: son motivo de rechazo en su control de calidad.
        - brand: La marca real del producto. Si no la tiene, exactamente "GENERICO".
        - conditionType: Exactamente uno de: "Nuevo", "Open Box", "Reacondicionado excelente (A)",
          "Reacondicionado detalle estético (B)".
        - model: El modelo del fabricante, o el nombre corto del producto si no hay modelo.
        - productionCountry: País de fabricación si se deduce; si no, déjalo vacío.
    `,
        jsonStructure: `"falabella": { "name": "string", "description": "string", "brand": "string", "conditionType": "string", "model": "string", "productionCountry": "string" }`,
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
