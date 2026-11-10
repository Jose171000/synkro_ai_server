import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import OpenAI from 'openai';
import { MarketplaceCategory } from './entities/marketplace-category.entity';
import { MarketplaceValueList } from './entities/marketplace-value-list.entity';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';
import { RipleyApiService } from '../sync/ripley/ripley-api.service';
import { EcommerceSyncService } from '../sync/channels/ecommerce-sync.service';
import { atributosPorCategoria, atributosParaGuardar, hojasDeRipley, listasDeValores, textoParaVector } from '../sync/ripley/ripley-categorias';

/**
 * Trae el catálogo de Ripley (Mirakl) a nuestra base, igual que se hizo con Falabella: cada categoría donde se puede publicar con su
 * ruta, su vector para que la IA la encuentre y sus atributos (obligatorios, recomendados, de variante), más las listas cerradas de
 * valores (colores, tipos de producto…) guardadas una sola vez. SOLO LECTURA contra Ripley: no se publica ni se cambia nada allá.
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
    ) {
        this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    private async embedBatch(textos: string[]): Promise<number[][]> {
        const salida: number[][] = [];
        for (let i = 0; i < textos.length; i += EMBEDDING_BATCH) {
            const respuesta = await this.openai.embeddings.create({ model: 'text-embedding-3-small', input: textos.slice(i, i + EMBEDDING_BATCH) });
            salida.push(...[...respuesta.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
            this.logger.log(`Vectores generados: ${Math.min(i + EMBEDDING_BATCH, textos.length)}/${textos.length}`);
        }
        return salida;
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

            const { jerarquias, atributos, listas } = await this.ripleyApi.leerCatalogo(this.ecommerce.authOf(cuenta));
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

            // 2) Categorías con vector y atributos
            const textos = hojas.map(textoParaVector);
            const vectores = await this.embedBatch(textos);
            const existentes = await this.categoryRepository.find({ where: { marketplace: 'ripley' }, select: { id: true, categoryId: true } });
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
                        embedding: vectores[i + j],
                    };
                });
                await this.categoryRepository.save(lote as any);
            }
            this.logger.log(`Catálogo de Ripley listo: ${hojas.length} categorías (${nuevas} nuevas, ${actualizadas} actualizadas), ${filasL.length} listas, ${atributosGuardados} atributos.`);
            return { categorias: hojas.length, nuevas, actualizadas, sinAtributos, listas: filasL.length, atributosGuardados };
        } finally {
            this.importando = false;
        }
    }
}
