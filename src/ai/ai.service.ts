import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { GenerateListingsDto } from './dto/generate-listings.dto';
import { MARKETPLACE_PROMPT_RULES } from './marketplace.constants';
import { VectorSearchService } from '../categories/vector-search.service';
import { CategorySeederService } from '../categories/category-seeder.service';
import { MarketplaceCategory, CategoryAttribute } from '../categories/entities/marketplace-category.entity';
import { ProductVisionService, ProductVision } from './product-vision.service';
import { ChannelAttributesService } from './channel-attributes.service';
import { opcionCercana } from '../common/opcion-cercana';
import { elegirImagenes, extraerUrlsDeImagen, normalizarContenido, quitarUrls, renderDescripcionHtml } from './description-html';
import { soloElNumero } from '../sync/falabella/falabella-fields';
import { medidasQueFaltan } from '../sync/meli/unidades-meli';
import { FalabellaCategoryImportService } from '../categories/falabella-category-import.service';
import OpenAI from 'openai';

@Injectable()
export class AiService {
  private openai: OpenAI;

  constructor(
    private readonly vectorSearchService: VectorSearchService,
    private readonly categorySeederService: CategorySeederService,
    private readonly vision: ProductVisionService,
    private readonly channelAttributes: ChannelAttributesService,
    private readonly falabellaImport: FalabellaCategoryImportService,
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
  public async generateProductContent(dto: {
    name: string, description: string, category?: string, subcategory?: string, targetMarketplaces: string[], tone?: string,
    /** Fotos del producto: la IA las mira para completar lo que el cliente no escribió. */
    imageUrls?: string[],
    /** Dueño de la cuenta: permite consultar a sus canales qué exige cada categoría. */
    userId?: string,
    /** Modo masivo: se estima todo lo que falte (datos obligatorios y medidas) para poder publicar sin revisión. */
    estimar?: boolean,
  }) {
    let categoryRequirements: Record<string, CategoryAttribute[]> = {};
    let catJson: any = {};
    // Resultado de verificar la categoría elegida en cada canal (hoy solo Falabella).
    const categoryChecks: Record<string, { id: string | null; confianza: string; motivo?: string; ruta?: string }> = {};

    // Los enlaces de imágenes o GIFs que el cliente pegó en su descripción van a la ficha HTML, no al texto que redacta la IA.
    const urlsDelCliente = extraerUrlsDeImagen(`${dto.name ?? ''} ${dto.description ?? ''}`);
    dto = { ...dto, name: quitarUrls(dto.name), description: quitarUrls(dto.description) };

    // PHASE 0: las fotos. Todo lo que se ve (tipo, color, material, marca) deja de depender de lo que escriba el cliente.
    const vision: ProductVision | null = dto.imageUrls?.length
      ? await this.vision.analyze(dto.imageUrls, { name: dto.name, description: dto.description })
      : null;
    const textoDelCliente = [dto.name, dto.description].filter(Boolean).join('. ');
    const enriquecido = this.combinarConVision(dto.name, dto.description, vision);
    // Sin texto y sin poder leer las fotos no hay de dónde sacar el producto: se pide más información.
    if (!enriquecido.name && !enriquecido.description) {
      throw new BadRequestException('No se pudo identificar el producto. Escribe una breve descripción o sube fotos más claras.');
    }
    dto = { ...dto, name: enriquecido.name, description: enriquecido.description };

    try {
      // PHASE A: Vector Search + LLM Categorization
      // Step 1: Get the embedding for the product text
      const productText = [dto.name, dto.description, vision?.productType, ...(vision?.keywords ?? [])].filter(Boolean).join(' ');
      const productEmbedding = await this.categorySeederService.generateEmbedding(productText);

      // Step 2: For each marketplace, find the top 5 most semantically similar categories
      const categoriesPerMarketplace: Record<string, MarketplaceCategory[]> = {};
      for (const marketplace of dto.targetMarketplaces) {
        const topCategories = await this.vectorSearchService.findSimilarCategories(
          productEmbedding,
          marketplace,
          // De Mercado Libre se piden más: parte de lo guardado son ejemplos de otro país que se descartan.
          marketplace.toLowerCase() === "mercadolibre" ? 20 : 5,
        );
        // Las categorías de ejemplo de Mercado Libre son de otro país: solo valen las del sitio configurado.
        const sitio = process.env.MELI_SITE_ID || 'MPE';
        categoriesPerMarketplace[marketplace.toLowerCase()] = marketplace.toLowerCase() === 'mercadolibre'
          ? topCategories.filter(c => c.categoryId.startsWith(sitio)).slice(0, 5)
          : topCategories;
      }

      // Falabella: sin categorías guardadas la IA no tenía de dónde elegir. Se piden al árbol de Falabella en
      // vivo (con las palabras del producto) y, en segundo plano, se importan todas para la próxima vez.
      if (dto.targetMarketplaces.map(m => m.toLowerCase()).includes('falabella') && dto.userId
        && (categoriesPerMarketplace['falabella']?.length ?? 0) < 3) {
        void this.falabellaImport.asegurarImportadas(dto.userId);
        const creds = await this.channelAttributes.credencialesDe(dto.userId).catch(() => null);
        if (creds) {
          const palabras = [vision?.productType ?? '', ...(vision?.keywords ?? []), ...enriquecido.titulo.split(/\s+/)].filter(Boolean);
          const vivas = await this.channelAttributes.candidatasFalabella(creds, palabras);
          categoriesPerMarketplace['falabella'] = [...(categoriesPerMarketplace['falabella'] ?? []), ...vivas].slice(0, 25);
        }
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

      // Falabella: la categoría se verifica con una segunda consulta; si ninguna encaja no se asigna ninguna
      // (publicar en la categoría equivocada es peor que pedir una revisión).
      if (dto.targetMarketplaces.map(m => m.toLowerCase()).includes('falabella')) {
        const creds = dto.userId ? await this.channelAttributes.credencialesDe(dto.userId).catch(() => null) : null;
        const r = await this.elegirCategoriaVerificada('falabella', enriquecido.name, enriquecido.description, categoriesPerMarketplace['falabella'] ?? [], {
          vision,
          preferida: catJson['falabella_category_id'] ? String(catJson['falabella_category_id']) : null,
          buscarMas: creds ? (palabras) => this.channelAttributes.candidatasFalabella(creds, palabras) : undefined,
        });
        categoryChecks['falabella'] = r;
        if (r.id) catJson['falabella_category_id'] = r.id;
        else delete catJson['falabella_category_id'];
      }

      // Step 4: Extract requiredAttributes from the matched category objects (already in memory)
      dto.targetMarketplaces.forEach(marketplace => {
        const electedId = catJson[`${marketplace.toLowerCase()}_category_id`];
        const topCats = categoriesPerMarketplace[marketplace.toLowerCase()] || [];
        const matched = topCats.find(c => c.categoryId === electedId);
        if (matched?.requiredAttributes) {
          categoryRequirements[marketplace.toLowerCase()] = matched.requiredAttributes;
        }
      });

      // Step 5: lo que cada canal REALMENTE pide. Mercado Libre tiene su propio clasificador
      // (las categorías guardadas aquí son de ejemplo y de otro país), y cada categoría
      // tiene sus atributos obligatorios con valores permitidos.
      for (const marketplace of dto.targetMarketplaces.map(m => m.toLowerCase())) {
        if (marketplace === 'mercadolibre') {
          const real = await this.channelAttributes.predecirCategoriaMeli(enriquecido.titulo);
          if (real) catJson['mercadolibre_category_id'] = real;
        }
        const categoryId = catJson[`${marketplace}_category_id`];
        if (!categoryId) continue;
        // Cada categoría consultada queda guardada con sus atributos y las palabras que llevaron a ella.
        const reales = await this.channelAttributes.requisitos(marketplace, String(categoryId), dto.userId, {
          titulo: enriquecido.titulo,
          palabras: [vision?.productType ?? '', ...(vision?.keywords ?? [])].filter(Boolean),
        });
        if (reales) categoryRequirements[marketplace] = reales;
      }

    } catch (error) {
      console.error('[AiService] Failed during Phase A Categorization:', error);
      categoryRequirements = {};
    }

    // 2. PHASE B: Construct and send the final prompt using the discovered requirements
    const generatorDto: GenerateListingsDto = {
      productName: dto.name,
      description: dto.description,
      targetMarketplaces: dto.targetMarketplaces,
      extractedAttributes: vision ? this.atributosDeVision(vision) : undefined,
      estimateMissing: dto.estimar,
      categoryRequirements
    };

    const generationPrompt = this.buildDynamicPrompt(generatorDto);

    try {
      const finalJson = await this.jsonDeLaIa(() => this.openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an AI that STRICTLY outputs valid JSON only.' },
          { role: 'user', content: generationPrompt }
        ]
      }));

      // Lo que la IA estimó (solo en modo masivo) se anota aparte y se quita de los atributos.
      const estimatedAttributes: Record<string, string[]> = {};
      for (const [marketplace, listing] of Object.entries<any>(finalJson ?? {})) {
        const lista = listing?.attributes?._estimated;
        if (listing?.attributes && '_estimated' in listing.attributes) {
          delete listing.attributes._estimated;
          if (Array.isArray(lista) && lista.length) estimatedAttributes[marketplace] = lista.map(String);
        }
      }

      // Descripción HTML estándar de la agencia para los canales que aceptan HTML.
      const aceptaHtml = dto.targetMarketplaces.map(m => m.toLowerCase()).some(m => ['falabella', 'shopify', 'woocommerce'].includes(m));
      const atributosParaFicha: Record<string, any> = { ...(vision ? this.atributosDeVision(vision) : {}) };
      for (const listing of Object.values<any>(finalJson ?? {})) Object.assign(atributosParaFicha, listing?.attributes ?? {});
      const ficha = aceptaHtml
        ? await this.generarDescripcionHtml({
            nombre: enriquecido.name,
            textoCliente: textoDelCliente,
            vision,
            atributos: atributosParaFicha,
            imagenesDelProducto: dto.imageUrls ?? [],
            urlsDelCliente,
          })
        : null;
      const htmlDescription = ficha?.html ?? null;

      // Falabella calcula el envío con las medidas del paquete: se estiman si el cliente no las dio.
      const packageEstimate = dto.targetMarketplaces.map(m => m.toLowerCase()).includes('falabella')
        ? await this.estimarPaquete(textoDelCliente, enriquecido.name, vision)
        : null;

      // Las medidas obligatorias de la categoría de Mercado Libre que la IA dejó vacías (p. ej. la profundidad) salen de las del paquete.
      const requisitosMeli = categoryRequirements['mercadolibre'] ?? [];
      const atributosMeli = finalJson?.mercadolibre?.attributes;
      if (atributosMeli && requisitosMeli.some((r: any) => r.isRequired && !String(atributosMeli[r.name] ?? '').trim())) {
        const paquete = packageEstimate ?? await this.estimarPaquete(textoDelCliente, enriquecido.name, vision);
        const medidas = medidasQueFaltan(atributosMeli, requisitosMeli, paquete);
        if (Object.keys(medidas).length) {
          Object.assign(atributosMeli, medidas);
          estimatedAttributes['mercadolibre'] = [...new Set([...(estimatedAttributes['mercadolibre'] ?? []), ...Object.keys(medidas)])];
        }
      }

      // Bundle the results from Phase A (Categorization) and Phase B (Generation) together
      return {
        categorizedAs: catJson,
        categoryChecks,
        generatedListings: finalJson,
        vision,
        packageEstimate,
        estimatedAttributes,
        htmlDescription,
        // Lo obligatorio que la IA no pudo deducir: es lo único que el cliente tiene que completar.
        missingAttributes: this.atributosFaltantes(finalJson, categoryRequirements),
      };

    } catch (error) {
      console.error('[AiService] Failed during Phase B Generation:', error);
      throw new InternalServerErrorException('Failed to generate product content via AI.');
    }
  }

  /** La IA a veces devuelve un JSON con comillas sin escapar: se pide de nuevo antes de dar el producto por fallido. */
  async jsonDeLaIa(pedir: () => Promise<any>, intentos = 3): Promise<any> {
    for (let i = 1; ; i++) {
      const respuesta = await pedir();
      try {
        return JSON.parse(respuesta.choices[0].message.content || '{}');
      } catch (error) {
        if (i >= intentos) throw error;
        console.warn(`[AiService] La IA devolvió un JSON inválido (intento ${i} de ${intentos}); se vuelve a pedir.`);
      }
    }
  }

  /** El nombre y la descripción que usa la IA: lo del cliente, completado con lo que se ve en las fotos. */
  private combinarConVision(name: string, description: string, vision: ProductVision | null) {
    const nombreCliente = (name ?? '').trim();
    const descCliente = (description ?? '').trim();
    if (!vision) return { name: nombreCliente, description: descCliente, titulo: nombreCliente };
    // Si el cliente solo escribió algo corto o repitió el mismo texto, el nombre de la foto es mejor base.
    const nombreVago = nombreCliente.length < 12;
    const nombre = nombreVago ? [vision.suggestedName, nombreCliente].filter(Boolean).join(' ') : nombreCliente;
    const descripcion = [descCliente, vision.description].filter((t, i, a) => t && a.indexOf(t) === i).join(' ');
    return { name: nombre, description: descripcion || nombre, titulo: nombreVago ? vision.suggestedName : nombreCliente };
  }

  /**
   * Medidas del paquete ya embalado (cm) y peso (kg). Si el cliente las dio en su texto se respetan
   * tal cual; si no, se estiman con lo que se sabe del producto. Devuelve null si no se pudo.
   */
  public async estimarPaquete(textoDelCliente: string, nombre: string, vision: ProductVision | null) {
    try {
      const respuesta = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an AI that STRICTLY outputs valid JSON only.' },
          {
            role: 'user',
            content: `Eres un experto en logística de e-commerce. Estima las dimensiones del PAQUETE ya embalado y listo para enviar de este producto.

Producto: ${nombre}
Tipo: ${vision?.productType ?? 'no indicado'} · Material: ${vision?.material ?? 'no indicado'}
Texto escrito por el cliente: "${textoDelCliente || '(nada)'}"

Reglas:
- Si el texto del cliente indica medidas o peso, úsalos EXACTOS (conviértelos a cm y kg).
- Lo que no indique, estímalo con valores típicos de ese tipo de producto ya empacado.
- Devuelve "fromClient": true SOLO si el cliente dio las cuatro cosas (ancho, largo, alto y peso).
- Valores positivos; ancho <= largo.

Responde únicamente: { "packageWidth": cm, "packageLength": cm, "packageHeight": cm, "packageWeight": kg, "fromClient": boolean }`,
          },
        ],
      });
      return normalizarPaquete(JSON.parse(respuesta.choices[0]?.message?.content || '{}'));
    } catch (error) {
      console.warn('[AiService] No se pudieron estimar las medidas del paquete:', error);
      return null;
    }
  }

  /**
   * Redacta la ficha HTML con el estándar de la agencia. La IA solo escribe los textos (en un JSON);
   * la estructura, los estilos y las imágenes los pone el código, así que la plantilla nunca cambia.
   * Imágenes: las que el cliente pasó (GIFs) y, si faltan, las fotos del producto.
   */
  public async generarDescripcionHtml(datos: {
    nombre: string; textoCliente: string; vision?: ProductVision | null; atributos?: Record<string, any>;
    imagenesDelProducto: string[]; urlsDelCliente: string[];
  }): Promise<{ html: string; title: string } | null> {
    try {
      const respuesta = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an AI that STRICTLY outputs valid JSON only.' },
          {
            role: 'user',
            content: `Actúa como un Copywriter Senior y Experto en SEO para E-commerce, especializado en optimizar catálogos para Falabella y otros marketplaces de alto rendimiento.
Transforma la información del producto en una ficha de ventas persuasiva. Solo redactas los textos; el diseño ya está resuelto.

Reglas:
- SEO: títulos y descripciones con palabras clave relevantes de forma natural. Que el cliente entienda rápido el valor del producto.
- COPYWRITING: convierte las características técnicas en beneficios claros.
- No inventes datos técnicos (medidas, materiales, certificaciones, garantías): usa solo lo que está en la información dada. Si falta un dato, no lo incluyas en "specs".
- Sin precios, datos de contacto ni menciones a otras tiendas.
- Español neutro, sin mayúsculas sostenidas ni signos de exclamación en exceso.

Producto: ${datos.nombre}
Información del cliente: ${datos.textoCliente || '(ninguna)'}
Tipo de producto: ${datos.vision?.productType ?? 'no indicado'}
Datos conocidos: ${JSON.stringify(datos.atributos ?? {})}

Responde únicamente este JSON:
{
  "title": "título del producto optimizado para SEO, entre 40 y 100 caracteres",
  "intro1": "párrafo 1: introducción persuasiva que conecta con el problema del cliente y presenta la solución",
  "intro2": "párrafo 2: detalle sobre la experiencia de uso o el beneficio principal",
  "benefits": [ { "subtitle": "beneficio", "text": "descripción corta e impactante", "alt": "texto alternativo SEO de la imagen" } ],
  "why": [ { "feature": "característica", "benefit": "beneficio que aporta" } ],
  "specs": [ { "label": "dato técnico", "value": "valor" } ]
}
"benefits" debe tener exactamente 4 elementos, "why" hasta 6 y "specs" hasta 8.`,
          },
        ],
      });
      const contenido = normalizarContenido(JSON.parse(respuesta.choices[0]?.message?.content || '{}'), datos.nombre);
      if (!contenido) return null;
      return { html: renderDescripcionHtml(contenido, elegirImagenes(datos.urlsDelCliente, datos.imagenesDelProducto)), title: contenido.title };
    } catch (error) {
      console.warn('[AiService] No se pudo generar la descripción HTML:', error);
      return null;
    }
  }

  /** Elige, entre candidatas, la categoría de un marketplace que mejor le va a un producto. */
  public async elegirCategoria(marketplace: string, nombre: string, descripcion: string, candidatas: MarketplaceCategory[]): Promise<string | null> {
    if (!candidatas.length) return null;
    try {
      const prompt = this.buildCategorizationPrompt(nombre, descripcion, [marketplace], { [marketplace.toLowerCase()]: candidatas });
      const r = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an AI that STRICTLY outputs valid JSON arrays and objects only.' },
          { role: 'user', content: prompt },
        ],
      });
      const id = JSON.parse(r.choices[0]?.message?.content || '{}')[`${marketplace.toLowerCase()}_category_id`];
      return id && candidatas.some(c => c.categoryId === String(id)) ? String(id) : null;
    } catch (error) {
      console.warn('[AiService] No se pudo elegir la categoría:', error);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Categoría: elegir, verificar y detectar las dudosas
  // ─────────────────────────────────────────────────────────────

  private static readonly CONECTORES = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'o', 'u', 'para', 'con', 'sin', 'en', 'por', 'un', 'una', 'a', 'al', 'and', 'the', 'of', 'for', 'with']);

  /** Palabras con significado de un texto: sin tildes, sin conectores y sin plurales simples. */
  private palabrasClave(texto: string): Set<string> {
    const limpio = String(texto ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9ñ\s]/g, ' ');
    const palabras = limpio.split(/\s+/).filter(p => p.length > 2 && !AiService.CONECTORES.has(p));
    return new Set(palabras.map(p => (p.length > 4 ? p.replace(/(es|s)$/, '') : p)));
  }

  /** ¿La ruta de la categoría comparte alguna palabra con el producto? Sin ninguna, la elección es sospechosa. */
  public coincidenciaDeCategoria(ruta: string, textos: (string | undefined | null)[]): boolean {
    const deLaRuta = this.palabrasClave(ruta);
    const delProducto = this.palabrasClave(textos.filter(Boolean).join(' '));
    for (const p of deLaRuta) {
      if (delProducto.has(p)) return true;
      for (const q of delProducto) if (p.length > 4 && q.length > 4 && (p.startsWith(q.slice(0, 5)) || q.startsWith(p.slice(0, 5)))) return true;
    }
    return false;
  }

  private async jsonDeIa(prompt: string): Promise<any | null> {
    try {
      const r = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are an AI that STRICTLY outputs valid JSON only.' },
          { role: 'user', content: prompt },
        ],
      });
      return JSON.parse(r.choices[0]?.message?.content || '{}');
    } catch (error: any) {
      console.warn('[AiService] Consulta de categoría no disponible:', error?.message);
      return null;
    }
  }

  private descripcionParaCategoria(nombre: string, descripcion: string, vision?: ProductVision | null): string {
    return [
      `Nombre: ${nombre}`,
      descripcion ? `Descripción: ${String(descripcion).slice(0, 500)}` : '',
      vision?.productType ? `Tipo de producto visto en las fotos: ${vision.productType}` : '',
      vision?.keywords?.length ? `Palabras clave: ${vision.keywords.slice(0, 8).join(', ')}` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * Segunda opinión sobre una categoría: ¿un comprador esperaría encontrar este producto ahí?
   * Si la consulta falla no se bloquea (ok con `incierta`), pero la confianza bajará.
   */
  public async verificarCategoria(
    nombre: string,
    descripcion: string,
    vision: ProductVision | null | undefined,
    ruta: string,
  ): Promise<{ ok: boolean; motivo: string; incierta?: boolean }> {
    const r = await this.jsonDeIa(`Eres un revisor estricto de catálogo de un marketplace.
Producto:
${this.descripcionParaCategoria(nombre, descripcion, vision)}

Categoría propuesta: ${ruta}

Razona en tres pasos antes de decidir:
1. ¿Qué ES exactamente el producto (tipo de artículo y para qué sirve)?
2. ¿Qué tipo de artículos se venden en la última categoría de la ruta propuesta?
3. ¿Son el MISMO tipo de artículo? No basta con que ambos sean de cocina, del hogar o eléctricos: debe ser el mismo tipo de artículo
   (una máquina para hacer donas NO va en secaplatos, ni en compactadores de basura, ni en vajilla).
Responde solo JSON: {"producto_es": "...", "categoria_vende": "...", "ok": true|false, "motivo": "una frase corta"}`);
    if (!r || typeof r.ok !== 'boolean') return { ok: true, motivo: 'no se pudo verificar', incierta: true };
    return { ok: r.ok, motivo: String(r.motivo ?? '').slice(0, 200) };
  }

  private async pedirCategoria(
    nombre: string,
    descripcion: string,
    vision: ProductVision | null | undefined,
    candidatas: MarketplaceCategory[],
  ): Promise<{ id: string | null; confianza: number; palabras: string[] }> {
    const lista = candidatas.map(c => `ID: "${c.categoryId}" -> ${c.name}`).join('\n');
    const r = await this.jsonDeIa(`Eres un experto clasificador de catálogo e-commerce.
Producto:
${this.descripcionParaCategoria(nombre, descripcion, vision)}

Categorías candidatas:
${lista}

Elige la categoría MÁS ESPECÍFICA donde este producto concreto se vendería. Si NINGUNA encaja de verdad, devuelve null:
es preferible no elegir a elegir una categoría de otro tipo de producto.
Responde solo JSON: {"category_id": "<ID de la lista o null>", "confidence": <número entre 0 y 1>,
"search_words": ["3 a 5 palabras en español que usarías para buscar la categoría correcta en el árbol del marketplace"]}`);
    const id = r?.category_id != null ? String(r.category_id) : null;
    return {
      id: id && candidatas.some(c => c.categoryId === id) ? id : null,
      confianza: Math.max(0, Math.min(1, Number(r?.confidence ?? 0.5))),
      palabras: Array.isArray(r?.search_words) ? r.search_words.map(String).slice(0, 5) : [],
    };
  }

  /**
   * Elige la categoría y la verifica con una segunda consulta. Si la verificación la rechaza, esa categoría se descarta y se
   * prueba otra; si ninguna candidata encaja, busca con otras palabras en el árbol del canal. Devuelve id nulo si nada convence:
   * es mejor no publicar que publicar en la categoría equivocada.
   */
  public async elegirCategoriaVerificada(
    marketplace: string,
    nombre: string,
    descripcion: string,
    candidatas: MarketplaceCategory[],
    opciones: {
      vision?: ProductVision | null;
      /** Categorías que ya se sabe que no sirven para este producto. */
      excluir?: string[];
      /** Una elección previa que solo hay que verificar. */
      preferida?: string | null;
      /** Búsqueda ampliada en el árbol del canal, con palabras nuevas. */
      buscarMas?: (palabras: string[]) => Promise<MarketplaceCategory[]>;
    } = {},
  ): Promise<{ id: string | null; confianza: 'alta' | 'baja' | 'ninguna'; motivo?: string; ruta?: string }> {
    const excluidas = new Set((opciones.excluir ?? []).map(String));
    const unicas = new Map<string, MarketplaceCategory>();
    for (const c of candidatas ?? []) if (c?.categoryId && !excluidas.has(String(c.categoryId))) unicas.set(String(c.categoryId), c);
    let pool = [...unicas.values()];
    let preferida = opciones.preferida && unicas.has(String(opciones.preferida)) ? String(opciones.preferida) : null;
    let ampliado = false;
    let ultimoMotivo = '';
    const textos = [nombre, descripcion.slice(0, 200), opciones.vision?.productType, ...(opciones.vision?.keywords ?? [])];

    for (let ronda = 0; ronda < 5; ronda++) {
      let elegida: MarketplaceCategory | undefined;
      let confianza = 0.8;
      let alternativas: string[] = [];
      if (preferida) {
        elegida = pool.find(c => String(c.categoryId) === preferida);
        preferida = null;
      } else if (pool.length) {
        const r = await this.pedirCategoria(nombre, descripcion, opciones.vision, pool);
        elegida = r.id ? pool.find(c => String(c.categoryId) === r.id) : undefined;
        confianza = r.confianza;
        alternativas = r.palabras;
      }

      if (!elegida) {
        if (!ampliado && opciones.buscarMas) {
          ampliado = true;
          const palabras = [...alternativas, opciones.vision?.productType ?? '', ...(opciones.vision?.keywords ?? []).slice(0, 4)].filter(Boolean);
          const mas = (await opciones.buscarMas(palabras).catch(() => [] as MarketplaceCategory[]))
            .filter(c => c?.categoryId && !excluidas.has(String(c.categoryId)) && !pool.some(p => String(p.categoryId) === String(c.categoryId)));
          if (mas.length) {
            pool = [...pool, ...mas];
            continue;
          }
        }
        return { id: null, confianza: 'ninguna', motivo: ultimoMotivo || 'ninguna categoría candidata encaja con el producto' };
      }

      const veredicto = await this.verificarCategoria(nombre, descripcion, opciones.vision, elegida.name);
      if (veredicto.ok) {
        const coincide = this.coincidenciaDeCategoria(elegida.name, textos);
        const alta = confianza >= 0.7 && coincide && !veredicto.incierta;
        return {
          id: String(elegida.categoryId),
          confianza: alta ? 'alta' : 'baja',
          ruta: elegida.name,
          ...(alta ? {} : { motivo: veredicto.incierta ? 'no se pudo verificar la categoría' : !coincide ? 'la categoría no comparte palabras con el producto: revisa que sea la correcta' : 'la IA no está segura de esta categoría' }),
        };
      }
      excluidas.add(String(elegida.categoryId));
      pool = pool.filter(c => String(c.categoryId) !== String(elegida!.categoryId));
      ultimoMotivo = veredicto.motivo || `«${elegida.name}» no corresponde al producto`;
    }
    return { id: null, confianza: 'ninguna', motivo: ultimoMotivo || 'ninguna categoría candidata encaja con el producto' };
  }

  /**
   * Completa de una vez los datos obligatorios de una categoría. Devuelve los valores y cuáles son estimados
   * (los que no se podían deducir y se eligió el más probable).
   */
  /**
   * Propone en qué se diferencian las fichas de una familia de variantes (color, talla, plazas…) y el valor de cada SKU,
   * leyendo títulos, atributos y SKU. Solo lo que esté escrito: si no hay certeza devuelve confianza «baja». El llamador
   * comprueba cada valor contra los datos de la ficha antes de usarlo.
   */
  public async proponerEjesDeVariacion(fichas: { sellerSku: string; nombre: string; variation: string | null; atributos: Record<string, string> }[]) {
    if (fichas.length < 2) return null;
    try {
      const lista = fichas.slice(0, 60).map((f) => `- SKU "${f.sellerSku}" | título: ${f.nombre.slice(0, 160)} | variación: ${f.variation ?? '-'} | atributos: ${JSON.stringify(f.atributos)}`).join('\n');
      const r = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are an AI that STRICTLY outputs valid JSON only.' },
          {
            role: 'user',
            content: `Estas fichas de un marketplace son variantes de un mismo producto. Indica en qué se diferencian (los ejes de variación: Color, Talla, Plazas, Tamaño, Modelo…) y el valor de cada SKU.

${lista}

Reglas estrictas:
- Usa SOLO lo que está escrito en el título, la variación, los atributos o el propio SKU. No inventes.
- El valor de cada SKU debe aparecer escrito en SU ficha (título, variación, atributo o SKU). Escribe los valores como palabras normales («Azul acero», «Beige claro»), no como códigos pegados. Si un código del SKU no se puede traducir con certeza (por ejemplo «PP» o «TU»), NO lo traduzcas ni lo adivines: devuelve confianza "baja".
- Los atributos que empiezan por «pagina_» son lo que muestra la página pública del marketplace para ESE SKU (talla, color…): son la mejor evidencia.
- Un título que lista varios colores ("BLANCO / NEGRO / BEIGE") es el mismo para todas: no sirve por sí solo para asignar un color a un SKU.
- Entre 1 y 3 ejes. Todos los SKU deben tener valor en todos los ejes y las combinaciones no pueden repetirse.
- Si no hay certeza: confianza "baja" y explica por qué en "motivo".
Responde solo un JSON: { "ejes": [{ "nombre": "Color", "evidencia": "de dónde sale" }], "valores": { "<SKU>": { "<nombre del eje>": "valor" } }, "confianza": "alta" | "media" | "baja", "motivo": "…" }`,
          },
        ],
      });
      const j = JSON.parse(r.choices[0]?.message?.content || '{}');
      const confianza = ['alta', 'media', 'baja'].includes(j.confianza) ? j.confianza : 'baja';
      return {
        ejes: Array.isArray(j.ejes) ? j.ejes.map((e: any) => ({ nombre: String(e?.nombre ?? ''), evidencia: e?.evidencia ? String(e.evidencia) : undefined })) : [],
        valores: j.valores && typeof j.valores === 'object' ? (j.valores as Record<string, Record<string, string>>) : {},
        confianza: confianza as 'alta' | 'media' | 'baja',
        motivo: j.motivo ? String(j.motivo) : undefined,
      };
    } catch (error: any) {
      console.warn(`[AI] No se pudieron proponer los ejes de variación: ${error?.message}`);
      return null;
    }
  }

  /**
   * Frases cortas, de lo que ES el producto (sin marca ni color), con las que buscar su categoría en Mercado Libre cuando
   * el título solo no la encuentra: «desmenuzador de pollo» → «utensilio para desmenuzar carne», «pinzas de cocina»…
   */
  public async consultasDeCategoria(nombre: string, descripcion: string): Promise<string[]> {
    try {
      const r = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an AI that STRICTLY outputs valid JSON only.' },
          {
            role: 'user',
            content: `Necesito encontrar la categoría de Mercado Libre Perú de este producto, pero el buscador no la halla con su título.
Producto: ${nombre}
Descripción: ${String(descripcion ?? '').slice(0, 600)}

Da de 4 a 6 frases de búsqueda en español, de 2 a 5 palabras, de lo que ES el producto: su tipo genérico y sinónimos o el grupo al que pertenece
(de lo más específico a lo más general). Sin marcas, colores ni medidas.
Responde solo un JSON: { "consultas": ["...", "..."] }`,
          },
        ],
      });
      const j = JSON.parse(r.choices[0]?.message?.content || '{}');
      return (Array.isArray(j.consultas) ? j.consultas : []).map((c: any) => String(c).trim()).filter(Boolean).slice(0, 6);
    } catch (error: any) {
      console.warn(`[AI] No se pudieron proponer consultas de categoría: ${error?.message}`);
      return [];
    }
  }

  public async completarAtributos(
    nombre: string,
    descripcion: string,
    atributos: CategoryAttribute[],
    conocidos: Record<string, any> = {},
    /** Todo lo que se sabe del producto: lo que escribió el cliente, lo que se ve en las fotos, las medidas y el SKU. */
    contexto: { textoCliente?: string; vision?: any; medidas?: string; sku?: string } = {},
  ) {
    // Los obligatorios se estiman si hace falta; los opcionales solo se llenan si el producto lo dice o se ve (suben la calidad de la ficha).
    if (!atributos.length) return { values: {} as Record<string, string>, estimated: [] as string[] };
    try {
      const lista = atributos.map(a => `- "${a.name}" (${a.isRequired ? 'OBLIGATORIO' : 'opcional'}): ${a.description}${a.options?.length ? ` — ${a.options.length > 120 ? 'LISTA CERRADA (algunas opciones): ' + a.options.slice(0, 120).join(' | ') + ' … Escribe el valor más cercano; se ajustará a la lista.' : 'ELIGE EXACTAMENTE UNO DE: ' + a.options.join(' | ')}` : ''}`).join('\n');
      const r = await this.openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an AI that STRICTLY outputs valid JSON only.' },
          {
            role: 'user',
            content: `Completa los datos de la ficha de este producto para publicarlo en un marketplace. Usa TODA la información disponible.
Título: ${nombre}
Texto que escribió el cliente: ${contexto.textoCliente || '(ninguno)'}
Descripción redactada: ${descripcion}
Lo que se ve en las fotos: ${contexto.vision ? JSON.stringify(contexto.vision) : '(sin fotos analizadas)'}
Medidas y peso del paquete: ${contexto.medidas || 'no indicados'}
SKU: ${contexto.sku || '-'}
Datos ya conocidos: ${JSON.stringify(conocidos)}

Datos a completar:
${lista}

Reglas:
- Completa TODO dato que se pueda sacar o deducir razonablemente de la información de arriba: material, color, grupo de edad, contenido del empaque, cantidad de piezas, peso o medidas del producto, tipo, uso, país de origen si se menciona, etc. No te quedes corto: un dato que se puede deducir y queda vacío baja la calidad de la ficha.
- Los campos de nombre en otro idioma (inglés, chino…) se llenan traduciendo el título del producto.
- «Detalle de la condición»: si el producto es nuevo, "Producto nuevo".
- Garantías (meses o condiciones), certificaciones, números de serie, códigos EAN/UPC y datos legales: solo si el cliente los escribió; si no, null.
- OBLIGATORIO que no se puede deducir: ESTIMA el valor más probable (con lista de opciones, la más cercana; si no, un valor genérico típico) y añade su nombre a "_estimated".
- Opcional que de verdad no se puede deducir: null. No inventes datos que cambian lo que compra el cliente (garantías, certificaciones).
- Si el dato lleva unidad de medida (peso, capacidad, garantía), escríbela junto al número (ej. "9 kg", "12 meses"), tal como indique su descripción.
- Si hay lista de opciones, el valor debe ser idéntico a una de ellas.
Responde solo un JSON: { "<nombre>": "valor", ..., "_estimated": ["nombre", ...] }`,
          },
        ],
      });
      const json = JSON.parse(r.choices[0]?.message?.content || '{}');
      const estimated: string[] = Array.isArray(json._estimated) ? json._estimated.map(String) : [];
      const values: Record<string, string> = {};
      for (const a of atributos) {
        const v = json[a.name];
        if (v === null || v === undefined || String(v).trim() === '') continue;
        const k = (t: string) => t.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
        if (a.options?.length) {
          // Exacta o, si no, la más cercana de la lista («madera de pino» → «Madera»).
          const valida = a.options.find(o => k(o) === k(String(v))) ?? opcionCercana(String(v), a.options);
          if (valida) values[a.name] = valida;
        } else if (a.valueType === 'number') {
          // Un campo numérico rechaza «3 niveles» o «20 platos»: se manda solo el número.
          const n = soloElNumero(String(v));
          if (n !== undefined) values[a.name] = n;
        } else {
          values[a.name] = String(v);
        }
      }
      return { values, estimated };
    } catch (error) {
      console.warn('[AiService] No se pudieron completar los atributos:', error);
      return { values: {} as Record<string, string>, estimated: [] as string[] };
    }
  }

  /** Datos de las fotos que van al prompt como atributos ya conocidos. */
  private atributosDeVision(vision: ProductVision): Record<string, any> {
    const base: Record<string, any> = {
      tipo: vision.productType, marca: vision.brand, color: vision.color, material: vision.material, genero: vision.gender,
      ...vision.attributes,
    };
    return Object.fromEntries(Object.entries(base).filter(([, v]) => v));
  }

  /** Atributos obligatorios de cada canal que quedaron vacíos tras la generación. */
  public atributosFaltantes(generated: any, requirements: Record<string, CategoryAttribute[]>): Record<string, { name: string; description: string; options?: string[] }[]> {
    const faltantes: Record<string, { name: string; description: string; options?: string[] }[]> = {};
    for (const [marketplace, atributos] of Object.entries(requirements ?? {})) {
      const rellenos = generated?.[marketplace]?.attributes ?? {};
      const sinValor = atributos
        .filter((a) => a.isRequired)
        .filter((a) => {
          const v = rellenos[a.name];
          return v === null || v === undefined || String(v).trim() === '' || /^(null|n\/a|desconocido|no especificado)$/i.test(String(v).trim());
        })
        .map((a) => ({ name: a.name, description: a.description, ...(a.options?.length ? { options: a.options } : {}) }));
      if (sinValor.length) faltantes[marketplace] = sinValor;
    }
    return faltantes;
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
    const { productName, description, targetMarketplaces, extractedAttributes, categoryRequirements, estimateMissing } = dto;

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
            attributeBlock += `\n    ${estimateMissing
              ? '[OBLIGATORIOS — complétalos SIEMPRE. Si no se deduce del producto, ESTIMA el valor más probable (si hay lista de opciones, la más cercana; si no, un valor genérico típico) y añade el nombre de ese atributo a "_estimated"]'
              : '[OBLIGATORIOS — complétalos con la información del producto. Si NO se puede deducir con certeza, devuelve null: NUNCA inventes un valor]'}:\n`;
            attributeBlock += required.map((a: CategoryAttribute) =>
              `      • "${a.name}": ${a.description}${a.options?.length ? ` — ELIGE EXACTAMENTE UNO DE: ${a.options.join(' | ')}` : ` (ejemplo: "${a.example}")`}`
            ).join('\n');
          }
          if (optional.length > 0) {
            attributeBlock += `\n    [OPCIONALES — completa si puedes inferirlos del producto]:\n`;
            attributeBlock += optional.map((a: CategoryAttribute) =>
              `      ◦ "${a.name}": ${a.description}${a.options?.length ? ` — si lo completas, elige uno de: ${a.options.join(' | ')}` : ` (ejemplo: "${a.example}")`}`
            ).join('\n');
          }

          dynamicInstructions += rules.instructions + `
      - ATRIBUTOS DE CATEGORÍA:${attributeBlock}
    `;

          // Build JSON schema: required attrs always included, optional marked with nullable hint
          const requiredKeys = required.map((a: CategoryAttribute) => `"${a.name}": "${a.example}"`).join(', ');
          const optionalKeys = optional.map((a: CategoryAttribute) => `"${a.name}": "${a.example} (opcional)"`).join(', ');
          const allKeys = [requiredKeys, optionalKeys, estimateMissing ? '"_estimated": ["NOMBRE_DEL_ATRIBUTO_ESTIMADO"]' : ''].filter(Boolean).join(', ');
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

/** Medidas del paquete que devuelve la IA → números seguros (cm enteros, kg), o null si no sirven. */
export function normalizarPaquete(crudo: any): { width: number; length: number; height: number; weight: number; fromClient: boolean } | null {
  if (!crudo || typeof crudo !== 'object') return null;
  const dim = (v: any) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), 1), 200) : null;
  };
  const peso = Number(crudo.packageWeight);
  const width = dim(crudo.packageWidth), length = dim(crudo.packageLength), height = dim(crudo.packageHeight);
  if (!width || !length || !height || !Number.isFinite(peso) || peso <= 0) return null;
  return { width, length, height, weight: Math.min(Math.round(peso * 1000) / 1000, 70), fromClient: crudo.fromClient === true };
}
