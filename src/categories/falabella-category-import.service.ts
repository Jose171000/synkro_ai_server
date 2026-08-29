import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import OpenAI from 'openai';
import { MarketplaceCategory } from './entities/marketplace-category.entity';
import { FalabellaApiService } from '../sync/falabella/falabella-api.service';
import { SyncService } from '../sync/sync.service';

/**
 * Trae el catálogo de categorías de Falabella para que la IA pueda elegir
 * entre ellas.
 *
 * Hasta ahora la IA solo conocía ocho categorías escritas a mano (cuatro de
 * Mercado Libre y cuatro de Amazon), así que para Falabella nunca proponía
 * ninguna y había que ponerla a mano en cada producto. Falabella publica sus
 * 2.732 categorías por API: se guardan aquí con su vector semántico y la
 * búsqueda por similitud que ya existía las empieza a considerar sola.
 */

/** Cuántos textos se mandan por petición al generar vectores. */
const EMBEDDING_BATCH = 100;

/** Cuántas filas se guardan de una vez. */
const SAVE_BATCH = 200;

export interface ImportResult {
    total: number;
    importadas: number;
    actualizadas: number;
    omitidas: number;
}

@Injectable()
export class FalabellaCategoryImportService {
    private readonly logger = new Logger('FalabellaCategorías');
    private readonly openai: OpenAI;

    constructor(
        @InjectRepository(MarketplaceCategory)
        private readonly categoryRepository: Repository<MarketplaceCategory>,
        private readonly falabellaApi: FalabellaApiService,
        private readonly syncService: SyncService,
    ) {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    /**
     * Texto que se convierte en vector.
     *
     * Se usa la ruta completa y no solo el nombre: "Accesorios" no dice nada,
     * pero "Automotriz › Accesorios y mantenimiento › Otros accesorios" sitúa
     * la categoría y hace que la búsqueda por parecido acierte mucho más.
     * Los separadores se cambian por espacios para no meter ruido.
     */
    private buildLabelText(name: string, path: string): string {
        return path.replace(/[›|]/g, ' ').replace(/\s+/g, ' ').trim() || name;
    }

    /** Genera vectores en lotes; de uno en uno serían miles de peticiones. */
    private async embedBatch(textos: string[]): Promise<number[][]> {
        const salida: number[][] = [];
        for (let i = 0; i < textos.length; i += EMBEDDING_BATCH) {
            const lote = textos.slice(i, i + EMBEDDING_BATCH);
            const respuesta = await this.openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: lote,
            });
            // La API mantiene el orden, pero se ordena por índice por si acaso:
            // un vector emparejado con la categoría equivocada sería invisible
            // y estropearía las sugerencias sin dar la cara.
            const ordenados = [...respuesta.data].sort((a, b) => a.index - b.index);
            salida.push(...ordenados.map(d => d.embedding));
            this.logger.log(`Vectores generados: ${Math.min(i + EMBEDDING_BATCH, textos.length)}/${textos.length}`);
        }
        return salida;
    }

    /**
     * Importa (o actualiza) las categorías de Falabella.
     *
     * Usa la conexión de Falabella del usuario indicado, ya que el árbol se
     * pide autenticado. Es idempotente: las que ya existen se actualizan.
     */
    async importCategories(userId: string): Promise<ImportResult> {
        const credentials = await this.syncService.getFalabellaCredentials(userId);
        const categorias = await this.falabellaApi.getCategories(credentials);

        if (!categorias.length) {
            return { total: 0, importadas: 0, actualizadas: 0, omitidas: 0 };
        }

        const existentes = await this.categoryRepository.find({
            where: { marketplace: 'falabella' },
            select: { id: true, categoryId: true },
        });
        const previas = new Map(existentes.map(c => [c.categoryId, c.id]));

        const textos = categorias.map(c => this.buildLabelText(c.name, c.path));
        const vectores = await this.embedBatch(textos);

        let importadas = 0;
        let actualizadas = 0;

        for (let i = 0; i < categorias.length; i += SAVE_BATCH) {
            const lote = categorias.slice(i, i + SAVE_BATCH).map((categoria, j) => {
                const indice = i + j;
                const existente = previas.get(categoria.id);
                if (existente) actualizadas++; else importadas++;
                return {
                    ...(existente ? { id: existente } : {}),
                    marketplace: 'falabella',
                    categoryId: categoria.id,
                    name: categoria.name,
                    labelText: textos[indice],
                    requiredAttributes: [],
                    embedding: vectores[indice],
                };
            });
            await this.categoryRepository.save(lote as any);
        }

        this.logger.log(
            `Categorías de Falabella listas: ${importadas} nuevas, ${actualizadas} actualizadas.`,
        );

        return {
            total: categorias.length,
            importadas,
            actualizadas,
            omitidas: 0,
        };
    }
}
