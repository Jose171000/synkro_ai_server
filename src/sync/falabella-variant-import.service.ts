import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { EjeDeVariacion, ProductGroup } from '../products/entities/product-group.entity';
import { normalizar } from '../products/variantes';
import { PlanDeGrupo } from './falabella/variantes-falabella';
import { SyncScope } from './sync.service';

export interface ResultadoDeAgrupar {
    gruposCreados: number;
    gruposActualizados: number;
    variantesAgrupadas: number;
    /** Grupos que no se pudieron armar o aplicar, con el motivo. */
    omitidos: { parentSku: string; motivo: string }[];
}

/**
 * Aplica en Synkro los grupos de variantes que salen de importar un canal. Solo enlaza productos que ya existen con su
 * grupo y los valores de cada eje: no toca fotos, precio, stock ni nombre de ninguna variante, así cada variante conserva
 * sus propias fotos.
 */
@Injectable()
export class FalabellaVariantImportService {
    private readonly logger = new Logger(FalabellaVariantImportService.name);

    constructor(
        @InjectRepository(Product) private readonly productRepository: Repository<Product>,
        @InjectRepository(ProductGroup) private readonly groupRepository: Repository<ProductGroup>,
    ) { }

    async aplicar(scope: SyncScope, grupos: PlanDeGrupo[], productosPorSku: Map<string, Product>): Promise<ResultadoDeAgrupar> {
        const resultado: ResultadoDeAgrupar = { gruposCreados: 0, gruposActualizados: 0, variantesAgrupadas: 0, omitidos: [] };
        if (!grupos.length) return resultado;

        // A qué grupo pertenece hoy cada producto, para no mover uno que ya está agrupado en otro lado.
        const idsInvolucrados = grupos.flatMap((g) => g.variants.map((v) => productosPorSku.get(v.sellerSku)?.id)).filter((x): x is string => !!x);
        const grupoActual = new Map<string, string | null>();
        for (const p of await this.productRepository.find({ where: { id: In(idsInvolucrados) }, relations: { group: true } })) grupoActual.set(p.id, p.group?.id ?? null);

        const existentes = new Map<string, ProductGroup>();
        for (const g of await this.groupRepository.find({ where: { store: { id: scope.storeId } } })) existentes.set(normalizar(g.parentSku), g);

        for (const plan of grupos) {
            try {
                const variantes = plan.variants
                    .map((v) => ({ producto: productosPorSku.get(v.sellerSku), values: v.values }))
                    .filter((v): v is { producto: Product; values: Record<string, string> } => !!v.producto);
                if (variantes.length < 2) {
                    resultado.omitidos.push({ parentSku: plan.parentSku, motivo: 'menos de dos de sus variantes están en esta tienda' });
                    continue;
                }

                let grupo = existentes.get(normalizar(plan.parentSku));
                let ejes: EjeDeVariacion[] = plan.axes;
                if (grupo) {
                    const mismosEjes = grupo.axes.length === plan.axes.length && grupo.axes.every((e) => plan.axes.some((p) => normalizar(p.name) === normalizar(e.name)));
                    if (!mismosEjes) {
                        resultado.omitidos.push({ parentSku: plan.parentSku, motivo: 'ya existe un producto con variantes con ese código y otros ejes' });
                        continue;
                    }
                    // Mismos ejes: se suman los valores nuevos a los que ya tenía.
                    ejes = grupo.axes.map((e) => {
                        const nuevo = plan.axes.find((p) => normalizar(p.name) === normalizar(e.name))!;
                        const vistos = new Set(e.values.map(normalizar));
                        return { name: e.name, values: [...e.values, ...nuevo.values.filter((v) => !vistos.has(normalizar(v)))] };
                    });
                    grupo.axes = ejes;
                    await this.groupRepository.save(grupo);
                    resultado.gruposActualizados++;
                } else {
                    grupo = await this.groupRepository.save(this.groupRepository.create({
                        name: plan.name,
                        parentSku: plan.parentSku,
                        axes: ejes,
                        owner: { id: scope.userId } as any,
                        store: { id: scope.storeId } as any,
                    }));
                    existentes.set(normalizar(plan.parentSku), grupo);
                    resultado.gruposCreados++;
                }

                for (const v of variantes) {
                    const actual = grupoActual.get(v.producto.id);
                    if (actual && actual !== grupo.id) {
                        resultado.omitidos.push({ parentSku: plan.parentSku, motivo: `el producto ${v.producto.sku} ya pertenece a otro grupo` });
                        continue;
                    }
                    // Solo grupo y valores: las fotos, el precio y el stock de cada variante no se tocan.
                    await this.productRepository.update(v.producto.id, { group: { id: grupo.id }, variantValues: v.values } as any);
                    resultado.variantesAgrupadas++;
                }
            } catch (error: any) {
                this.logger.warn(`No se pudo agrupar ${plan.parentSku}: ${error?.message}`);
                resultado.omitidos.push({ parentSku: plan.parentSku, motivo: error?.code === '23505' ? 'ya hay otro grupo con ese código en la tienda' : 'error al guardar el grupo' });
            }
        }
        return resultado;
    }
}
