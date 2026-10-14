import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CategoryAttribute } from '../categories/entities/marketplace-category.entity';
import { MeliApiService } from '../sync/meli/meli-api.service';
import { FalabellaApiService } from '../sync/falabella/falabella-api.service';
import { SyncService } from '../sync/sync.service';
import { MarketplaceConnection } from '../sync/entities/marketplace-connection.entity';

/** Cuántos atributos opcionales se piden: más de eso solo infla el prompt. */
const MAX_OPCIONALES = 10;
const MAX_OPCIONES = 40;

/** Datos que la plataforma ya cubre por su cuenta al publicar en Falabella. */
const YA_CUBIERTOS_FALABELLA = new Set([
    'name', 'brand', 'description', 'primary_category', 'seller_sku',
    'condition_type', 'package_width', 'package_length', 'package_height',
    'package_weight', 'variation', 'price', 'stock', 'status',
]);

/** Atributos de Mercado Libre que se resuelven aparte (marca y modelo ya van en la publicación). */
const YA_CUBIERTOS_MELI = new Set(['BRAND', 'MODEL']);

/** Atributos de una categoría de Mercado Libre → lo que entiende el prompt. */
export function atributosDeMeli(crudos: any[]): CategoryAttribute[] {
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
    const opcionales = validos.filter((a) => !a.tags?.required).map(mapear).slice(0, MAX_OPCIONALES);
    return [...obligatorios, ...opcionales];
}

/**
 * Pregunta a cada canal qué exige una categoría. Es lo que hace que la IA
 * llene los datos que el canal realmente pide y no unos inventados.
 */
@Injectable()
export class ChannelAttributesService {
    private readonly logger = new Logger(ChannelAttributesService.name);

    constructor(
        private readonly meli: MeliApiService,
        private readonly falabella: FalabellaApiService,
        private readonly sync: SyncService,
        @InjectRepository(MarketplaceConnection)
        private readonly connections: Repository<MarketplaceConnection>,
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

    /** Atributos que pide la categoría, o null si no se pudieron consultar. */
    async requisitos(marketplace: string, categoryId: string, userId?: string): Promise<CategoryAttribute[] | null> {
        try {
            if (marketplace === 'mercadolibre') {
                const atributos = atributosDeMeli(await this.meli.getCategoryAttributes(categoryId));
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
                    .filter((a) => a.isMandatory && !YA_CUBIERTOS_FALABELLA.has(a.name))
                    .map((a) => ({
                        name: a.feedName || a.name,
                        description: a.label || a.name,
                        example: a.options?.[0] ?? '',
                        isRequired: true,
                        ...(a.options?.length ? { options: a.options.slice(0, MAX_OPCIONES) } : {}),
                    }));
                return lista.length ? lista : null;
            }
        } catch (error: any) {
            this.logger.warn(`Atributos de ${marketplace}/${categoryId} no disponibles: ${error?.message}`);
        }
        return null;
    }
}
