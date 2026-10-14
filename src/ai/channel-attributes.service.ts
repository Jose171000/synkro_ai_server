import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CategoryAttribute, MarketplaceCategory } from '../categories/entities/marketplace-category.entity';
import { CategorySeederService } from '../categories/category-seeder.service';
import { MeliApiService } from '../sync/meli/meli-api.service';
import { FalabellaApiService } from '../sync/falabella/falabella-api.service';
import { SyncService } from '../sync/sync.service';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';

/** Cuántos atributos opcionales se piden a la IA: más de eso solo infla el prompt. */
const MAX_OPCIONALES = 10;
const MAX_OPCIONES = 40;
/** Lo aprendido se vuelve a consultar al canal pasado este tiempo: los canales cambian sus categorías. */
const VIGENCIA_MS = 30 * 24 * 3600 * 1000;
/** Tope del texto que describe una categoría; al llenarse deja de aprender palabras. */
const MAX_LABEL = 500;

/** Datos que la plataforma ya cubre por su cuenta al publicar en Falabella. */
const YA_CUBIERTOS_FALABELLA = new Set([
    'name', 'brand', 'description', 'primary_category', 'seller_sku',
    'condition_type', 'package_width', 'package_length', 'package_height',
    'package_weight', 'variation', 'price', 'stock', 'status',
]);

/** Atributos de Mercado Libre que se resuelven aparte (marca y modelo ya van en la publicación). */
const YA_CUBIERTOS_MELI = new Set(['BRAND', 'MODEL']);

/** Atributos de una categoría de Mercado Libre → lo que entiende el prompt y lo que se guarda. */
export function atributosDeMeli(crudos: any[], maxOpcionales = MAX_OPCIONALES): CategoryAttribute[] {
    const validos = (crudos ?? []).filter((a) => {
        const tags = a?.tags ?? {};
        return a?.id && !YA_CUBIERTOS_MELI.has(a.id) && !tags.hidden && !tags.read_only && !tags.fixed && !tags.inferred;
    });
    const mapear = (a: any): CategoryAttribute => {
        const opciones = Array.isArray(a.values) ? a.values.map((v: any) => v?.name).filter(Boolean).slice(0, MAX_OPCIONES) : [];
        const unidades = Array.isArray(a.allowed_units) ? a.allowed_units.map((u: any) => u?.name).filter(Boolean) : [];
        const partes = [a.name, a.hint, unidades.length ? `unidades: ${unidades.join('/')}` : null].filter(Boolean);
        return {
            name: a.id,
            description: partes.join(' — '),
            example: opciones[0] ?? '',
            isRequired: !!a.tags?.required,
            ...(opciones.length ? { options: opciones } : {}),
        };
    };
    const obligatorios = validos.filter((a) => a.tags?.required).map(mapear);
    const opcionales = validos.filter((a) => !a.tags?.required).map(mapear).slice(0, maxOpcionales);
    return [...obligatorios, ...opcionales];
}

/** Lo que va a la IA: todo lo obligatorio y unos pocos opcionales. */
export function paraLaIa(atributos: CategoryAttribute[]): CategoryAttribute[] {
    return [...atributos.filter((a) => a.isRequired), ...atributos.filter((a) => !a.isRequired).slice(0, MAX_OPCIONALES)];
}

/** Contexto del producto que se está creando: de aquí aprende la categoría. */
export interface ContextoDeProducto {
    titulo?: string;
    palabras?: string[];
}

/**
 * Pregunta a cada canal qué exige una categoría y se lo acuerda.
 *
 * Cada producto que se crea deja la categoría y todos sus atributos (obligatorios
 * o no, con sus valores permitidos) en nuestra base de datos, junto con su vector.
 * Así el catálogo crece solo: la siguiente vez ya no hay que preguntar al canal,
 * y la búsqueda por significado conoce más categorías y más palabras para llegar a ellas.
 */
@Injectable()
export class ChannelAttributesService {
    private readonly logger = new Logger(ChannelAttributesService.name);

    constructor(
        private readonly meli: MeliApiService,
        private readonly falabella: FalabellaApiService,
        private readonly sync: SyncService,
        private readonly seeder: CategorySeederService,
        @InjectRepository(MarketplaceConnection)
        private readonly connections: Repository<MarketplaceConnection>,
        @InjectRepository(MarketplaceCategory)
        private readonly categories: Repository<MarketplaceCategory>,
    ) { }

    /** Categoría real de Mercado Libre para un título (el predictor oficial). */
    async predecirCategoriaMeli(titulo: string): Promise<string | null> {
        try {
            return (await this.meli.predictCategory(undefined, titulo.slice(0, 120))) ?? null;
        } catch (error: any) {
            this.logger.warn(`Categoría de Mercado Libre no disponible: ${error?.message}`);
            return null;
        }
    }

    /**
     * Atributos que pide la categoría, o null si no se pudieron conseguir.
     * Primero lo ya aprendido (si es reciente); si no, se pregunta al canal y se aprende.
     */
    async requisitos(
        marketplace: string,
        categoryId: string,
        userId?: string,
        contexto?: ContextoDeProducto,
    ): Promise<CategoryAttribute[] | null> {
        let guardada: MarketplaceCategory | null = null;
        try {
            guardada = await this.categories.findOne({
                where: { marketplace, categoryId },
                select: { id: true, requiredAttributes: true, labelText: true, updatedAt: true },
            });
        } catch (error: any) {
            this.logger.warn(`No se pudo leer lo aprendido de ${marketplace}/${categoryId}: ${error?.message}`);
        }

        const aprendidos = guardada?.requiredAttributes?.length ? guardada.requiredAttributes : null;
        const vigente = !!guardada && !!aprendidos && Date.now() - new Date(guardada.updatedAt).getTime() < VIGENCIA_MS;
        if (aprendidos && vigente) {
            await this.aprenderPalabras(guardada!, contexto);
            return this.paraElCanal(marketplace, aprendidos);
        }

        const completos = await this.consultarAlCanal(marketplace, categoryId, userId);
        if (completos) {
            await this.recordar(marketplace, categoryId, completos, guardada, contexto);
            return this.paraElCanal(marketplace, completos);
        }
        // El canal no respondió: mejor lo aprendido aunque esté viejo que nada.
        return aprendidos ? this.paraElCanal(marketplace, aprendidos) : null;
    }

    private paraElCanal(marketplace: string, atributos: CategoryAttribute[]): CategoryAttribute[] {
        // Falabella rechaza el lote si falta un obligatorio; los opcionales no aportan.
        return marketplace === 'falabella' ? atributos.filter((a) => a.isRequired) : paraLaIa(atributos);
    }

    /** Todos los atributos de la categoría, tal como los publica el canal. */
    private async consultarAlCanal(marketplace: string, categoryId: string, userId?: string): Promise<CategoryAttribute[] | null> {
        try {
            if (marketplace === 'mercadolibre') {
                const atributos = atributosDeMeli(await this.meli.getCategoryAttributes(categoryId), Infinity);
                return atributos.length ? atributos : null;
            }
            if (marketplace === 'falabella' && userId) {
                const cuenta = await this.connections.findOne({
                    where: { marketplace: 'falabella', owner: { id: userId }, status: 'active' } as any,
                });
                if (!cuenta) return null;
                const credenciales = await this.sync.getFalabellaCredentials(cuenta.id);
                const atributos = await this.falabella.getCategoryAttributes(credenciales, categoryId);
                const lista: CategoryAttribute[] = atributos
                    .filter((a) => !YA_CUBIERTOS_FALABELLA.has(a.name))
                    .map((a) => ({
                        name: a.feedName || a.name,
                        description: a.label || a.name,
                        example: a.options?.[0] ?? '',
                        isRequired: !!a.isMandatory,
                        ...(a.options?.length ? { options: a.options.slice(0, MAX_OPCIONES) } : {}),
                    }));
                return lista.length ? lista : null;
            }
        } catch (error: any) {
            this.logger.warn(`Atributos de ${marketplace}/${categoryId} no disponibles: ${error?.message}`);
        }
        return null;
    }

    /** Guarda la categoría y sus atributos en la base de datos vectorial. Nunca interrumpe la creación del producto. */
    private async recordar(
        marketplace: string,
        categoryId: string,
        atributos: CategoryAttribute[],
        existente: MarketplaceCategory | null,
        contexto?: ContextoDeProducto,
    ): Promise<void> {
        try {
            if (existente) {
                await this.categories.update({ id: existente.id }, { requiredAttributes: atributos as any });
                await this.aprenderPalabras(existente, contexto);
                return;
            }
            // Una categoría que no teníamos: se guarda con su ruta completa y su vector.
            if (marketplace !== 'mercadolibre') return; // las de Falabella llegan con su importación
            const info = await this.meli.getCategory(categoryId).catch(() => null);
            const ruta = (info?.path_from_root ?? []).map((n: any) => n?.name).filter(Boolean).join(' ');
            const nombre = info?.name ?? categoryId;
            const labelText = this.unirPalabras(ruta || nombre, contexto);
            const embedding = await this.seeder.generateEmbedding(labelText).catch(() => null);
            await this.categories.save(this.categories.create({
                marketplace, categoryId, name: nombre, labelText,
                requiredAttributes: atributos, embedding: embedding as any,
            }));
            this.logger.log(`Categoría aprendida: ${marketplace}/${categoryId} «${nombre}» con ${atributos.length} atributos.`);
        } catch (error: any) {
            // Típico: dos productos aprendieron la misma categoría a la vez (clave duplicada). No importa.
            this.logger.warn(`No se pudo guardar ${marketplace}/${categoryId}: ${error?.message}`);
        }
    }

    /** Añade al texto de la categoría las palabras con las que la gente llega a ella. */
    private unirPalabras(base: string, contexto?: ContextoDeProducto): string {
        const yaEsta = base.toLowerCase();
        const nuevas = [contexto?.titulo, ...(contexto?.palabras ?? [])]
            .map((p) => (p ?? '').trim().toLowerCase())
            .filter((p, i, a) => p && p.length > 2 && a.indexOf(p) === i && !yaEsta.includes(p));
        return [base, ...nuevas].join(' ').slice(0, MAX_LABEL);
    }

    /** Cada producto enseña palabras nuevas de la categoría; solo se recalcula el vector si hubo algo nuevo. */
    private async aprenderPalabras(categoria: Pick<MarketplaceCategory, 'id' | 'labelText'>, contexto?: ContextoDeProducto): Promise<void> {
        try {
            if (!contexto || !categoria.labelText || categoria.labelText.length >= MAX_LABEL) return;
            const labelText = this.unirPalabras(categoria.labelText, contexto);
            if (labelText === categoria.labelText) return;
            const embedding = await this.seeder.generateEmbedding(labelText);
            await this.categories.save({ id: categoria.id, labelText, embedding } as any);
        } catch (error: any) {
            this.logger.warn(`No se pudieron aprender palabras de la categoría ${categoria.id}: ${error?.message}`);
        }
    }
}
