import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import OpenAI from 'openai';
import { MarketplaceCategory } from './entities/marketplace-category.entity';
import { MarketplaceValueList } from './entities/marketplace-value-list.entity';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';
import { RipleyApiService } from '../sync/ripley/ripley-api.service';
import { EcommerceSyncService } from '../sync/channels/ecommerce-sync.service';
import { SyncService } from '../sync/sync.service';
import { atributosPorCategoria, atributosParaGuardar, hojasDeRipley, listasDeValores, textoParaVector } from '../sync/ripley/ripley-categorias';

/**
 * Trae el catálogo de Ripley (Mirakl) a nuestra base, igual que se hizo con Falabella: cada categoría donde se puede publicar con su
 * ruta, su vector para que la IA la encuentre y sus atributos (obligatorios, recomendados, de variante), más las listas cerradas de
 * valores (colores, tipos de producto…) guardadas una sola vez. SOLO LECTURA contra Ripley: no se publica ni se cambia nada allá.
 *
 * Los vectores (OpenAI) son un paso aparte: si fallan (p. ej. cuenta sin créditos), las categorías y sus atributos ya quedaron
 * guardados y basta con repetir la importación para completar solo los vectores que faltan.
 */
const EMBEDDING_BATCH = 100;
const SAVE_BATCH = 200;

export interface RipleyImportResult {
    categorias: number;
    nuevas: number;
    actualizadas: number;
    sinAtributos: number;
    listas: number;
    atributosGuardados: number;
    vectoresGenerados: number;
    vectoresPendientes: number;
    aviso: string | null;
}

@Injectable()
export class RipleyCategoryImportService {
    private readonly logger = new Logger('RipleyCategorías');
    private readonly openai: OpenAI;
    private importando = false;

    constructor(
        @InjectRepository(MarketplaceCategory) private readonly categoryRepository: Repository<MarketplaceCategory>,
        @InjectRepository(MarketplaceValueList) private readonly listRepository: Repository<MarketplaceValueList>,
        @InjectRepository(MarketplaceConnection) private readonly connections: Repository<MarketplaceConnection>,
        private readonly ripleyApi: RipleyApiService,
        private readonly ecommerce: EcommerceSyncService,
        private readonly sync: SyncService,
    ) {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    private async embedBatch(textos: string[]): Promise<number[][]> {
        const respuesta = await this.openai.embeddings.create({ model: 'text-embedding-3-small', input: textos });
        return [...respuesta.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }

    /** Importa (o actualiza) las categorías, sus atributos y las listas de valores de Ripley. Se puede repetir. */
    async importar(userId: string): Promise<RipleyImportResult> {
        if (this.importando) throw new BadRequestException('Ya hay una importación de categorías de Ripley en curso.');
        this.importando = true;
        try {
            // El catálogo es el mismo para todas las tiendas: sirve la cuenta del usuario o, si no tiene, cualquiera activa.
            const cuenta =
                (await this.connections.findOne({ where: { marketplace: 'ripley', status: 'active', owner: { id: userId } } as any })) ??
                (await this.connections.findOne({ where: { marketplace: 'ripley', status: 'active' } as any }));
            if (!cuenta) throw new BadRequestException('No hay ninguna cuenta de Ripley conectada para traer su catálogo.');

            // La conexión «validada» es la que trae las credenciales listas para usar (igual que en el resto de funciones de Ripley).
            const valida = await this.sync.getValidConnectionById(cuenta.id);
            this.logger.log('Leyendo el catálogo de Ripley (categorías, atributos y listas)…');
            const { jerarquias, atributos, listas } = await this.ripleyApi.leerCatalogo(this.ecommerce.authOf(valida));
            this.logger.log(`Ripley devolvió ${jerarquias.length} categorías, ${atributos.length} atributos y ${listas.length} listas.`);
            const hojas = hojasDeRipley(jerarquias);
            if (!hojas.length) throw new BadRequestException('Ripley no devolvió ninguna categoría.');

            const valores = listasDeValores(listas);
            const porCategoria = atributosPorCategoria(atributos);

            // 1) Listas de valores (una vez cada una)
            const existentesL = await this.listRepository.find({ where: { marketplace: 'ripley' }, select: { id: true, code: true } });
            const idDeLista = new Map(existentesL.map((l) => [l.code, l.id]));
            const filasL = listas.filter((l) => l?.code).map((l) => ({
                ...(idDeLista.has(String(l.code)) ? { id: idDeLista.get(String(l.code)) } : {}),
                marketplace: 'ripley',
                code: String(l.code),
                label: l.label ?? null,
                values: valores.get(String(l.code)) ?? [],
            }));
            for (let i = 0; i < filasL.length; i += 20) await this.listRepository.save(filasL.slice(i, i + 20) as any);

            // 2) Categorías y atributos. Se guardan SIN esperar a los vectores: así no dependen de OpenAI, y la búsqueda por vector
            // ignora las que aún no lo tienen.
            const textos = hojas.map(textoParaVector);
            const existentes: { id: string; categoryId: string; tiene: boolean }[] = await this.categoryRepository.query(
                `SELECT id, "categoryId", (embedding IS NOT NULL) AS tiene FROM marketplace_categories WHERE marketplace = 'ripley'`,
            );
            const previas = new Map(existentes.map((c) => [c.categoryId, c.id]));

            let nuevas = 0, actualizadas = 0, sinAtributos = 0, atributosGuardados = 0;
            for (let i = 0; i < hojas.length; i += SAVE_BATCH) {
                const lote = hojas.slice(i, i + SAVE_BATCH).map((h, j) => {
                    const previa = previas.get(h.codigo);
                    if (previa) actualizadas++; else nuevas++;
                    const atributosDeLaCategoria = atributosParaGuardar(porCategoria.get(h.codigo) ?? [], valores);
                    if (!atributosDeLaCategoria.length) sinAtributos++;
                    atributosGuardados += atributosDeLaCategoria.length;
                    return {
                        ...(previa ? { id: previa } : {}),
                        marketplace: 'ripley',
                        categoryId: h.codigo,
                        name: h.ruta,
                        labelText: textos[i + j],
                        requiredAttributes: atributosDeLaCategoria,
                    };
                });
                await this.categoryRepository.save(lote as any);
            }

            // 3) Vectores de las que todavía no tienen (si OpenAI falla, lo demás ya quedó guardado y se completa al repetir).
            const conVector = new Set(existentes.filter((c) => c.tiene).map((c) => c.categoryId));
            const pendientes = hojas.filter((h) => !conVector.has(h.codigo));
            let vectoresGenerados = 0;
            let aviso: string | null = null;
            try {
                const ids: { id: string; categoryId: string }[] = await this.categoryRepository.query(
                    `SELECT id, "categoryId" FROM marketplace_categories WHERE marketplace = 'ripley'`,
                );
                const idDe = new Map(ids.map((c) => [c.categoryId, c.id]));
                for (let i = 0; i < pendientes.length; i += EMBEDDING_BATCH) {
                    const lote = pendientes.slice(i, i + EMBEDDING_BATCH);
                    const vectores = await this.embedBatch(lote.map(textoParaVector));
                    await this.categoryRepository.query(
                        `UPDATE marketplace_categories AS c SET embedding = v.e FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS e) AS v WHERE c.id = v.id`,
                        [lote.map((h) => idDe.get(h.codigo)), vectores.map((v) => `[${v.join(',')}]`)],
                    );
                    vectoresGenerados += lote.length;
                    this.logger.log(`Vectores generados: ${vectoresGenerados}/${pendientes.length}`);
                }
            } catch (error: any) {
                aviso = `Las categorías y atributos quedaron guardados, pero faltan los vectores de la búsqueda por significado (${String(error?.message ?? error).slice(0, 160)}). Repite la importación cuando se resuelva.`;
                this.logger.warn(aviso);
            }

            this.logger.log(`Catálogo de Ripley listo: ${hojas.length} categorías (${nuevas} nuevas, ${actualizadas} actualizadas), ${filasL.length} listas, ${atributosGuardados} atributos, ${vectoresGenerados}/${pendientes.length} vectores.`);
            return { categorias: hojas.length, nuevas, actualizadas, sinAtributos, listas: filasL.length, atributosGuardados, vectoresGenerados, vectoresPendientes: pendientes.length - vectoresGenerados, aviso };
        } catch (error: any) {
            // Un fallo inesperado (base de datos…) no debe salir como un «Internal server error» mudo.
            if (error instanceof HttpException) throw error;
            this.logger.error(`La importación de Ripley falló: ${error?.message}`, error?.stack);
            throw new BadRequestException(`La importación de Ripley falló: ${String(error?.message ?? error).slice(0, 300)}`);
        } finally {
            this.importando = false;
        }
    }
}
