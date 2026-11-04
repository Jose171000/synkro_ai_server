import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { EjeDeVariacion, ProductGroup } from '../products/entities/product-group.entity';
import { claveDeCombinacion, normalizar, valoresDeVariante } from '../products/variantes';
import { PlanDeGrupo } from './falabella/variantes-falabella';
import { SyncScope } from './sync.service';

export interface ResultadoDeAgrupar {
    gruposCreados: number;
    gruposActualizados: number;
    variantesAgrupadas: number;
    /** Grupos que no se pudieron armar o aplicar, con el motivo. */
    omitidos: { parentSku: string; motivo: string }[];
}

/** Lo que la persona escribe al estructurar una familia a mano. */
export interface EntradaManual { parentSku: string; name: string; axes: string[]; variants: { sellerSku: string; values: Record<string, string> }[] }

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

    /**
     * Agrupa a mano: la persona define el nombre, los ejes y el valor de cada SKU (el último recurso cuando ni la página
     * pública ni la IA pudieron). Se valida todo igual que en una creación: un valor por eje en cada variante y ninguna
     * combinación repetida.
     */
    async agruparManual(scope: SyncScope, entrada: EntradaManual): Promise<ResultadoDeAgrupar> {
        const plan = this.planearManual(entrada);
        const { variants } = plan;
        const skus = variants.map((v) => v.sellerSku);
        const encontrados: Product[] = await this.productRepository.createQueryBuilder('p')
            .where('(p.storeId = :storeId OR (p.storeId IS NULL AND p.ownerId = :userId))', { storeId: scope.storeId, userId: scope.userId })
            .andWhere('LOWER(TRIM(p.sku)) IN (:...skus)', { skus: skus.map((s) => s.toLowerCase()) })
            .getMany();
        const porSku = new Map(encontrados.map((p) => [p.sku.trim().toLowerCase(), p]));
        const faltan = skus.filter((s) => !porSku.has(s.toLowerCase()));
        if (faltan.length) throw new BadRequestException(`Estos SKU no están en la tienda: ${faltan.slice(0, 5).join(', ')}. Importa primero las publicaciones.`);

        const resultado = await this.aplicar(scope, [plan], new Map(skus.map((s) => [s, porSku.get(s.toLowerCase())!])));
        if (!resultado.variantesAgrupadas) throw new BadRequestException(resultado.omitidos[0]?.motivo ?? 'No se pudo agrupar.');
        return resultado;
    }

    /**
     * Al importar: aplica los grupos que la persona estructuró a mano en la vista previa. Los productos todavía no existían
     * cuando los definió; la importación los crea (o los enlaza) y aquí se agrupan en el mismo paso, con los ejes y valores
     * escritos. Un grupo mal armado no frena la importación: queda en la lista de omitidos con su motivo.
     */
    async aplicarManuales(scope: SyncScope, entradas: EntradaManual[], productosPorSku: Map<string, Product>): Promise<ResultadoDeAgrupar> {
        const planes: PlanDeGrupo[] = [];
        const invalidos: { parentSku: string; motivo: string }[] = [];
        for (const e of entradas) {
            try {
                planes.push(this.planearManual(e));
            } catch (error: any) {
                invalidos.push({ parentSku: String(e?.parentSku ?? ''), motivo: error?.message ?? 'No se pudo armar el grupo.' });
            }
        }
        const resultado = await this.aplicar(scope, planes, productosPorSku);
        resultado.omitidos.push(...invalidos);
        return resultado;
    }

    /** Valida lo que escribió la persona y lo deja como un plan de grupo; no toca la base. */
    planearManual(entrada: EntradaManual): PlanDeGrupo {
        const nombres = entrada.axes.map((a) => String(a ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean);
        if (!nombres.length || new Set(nombres.map(normalizar)).size !== nombres.length) throw new BadRequestException('Indica de 1 a 3 ejes con nombres distintos (por ejemplo Color o Talla).');

        // El eje tiene los valores que la persona escribió en las variantes, sin repetir (sin distinguir mayúsculas ni tildes).
        const axes: EjeDeVariacion[] = nombres.map((nombre) => {
            const vistos = new Set<string>();
            const values: string[] = [];
            for (const v of entrada.variants) {
                const dado = Object.entries(v.values ?? {}).find(([k]) => normalizar(k) === normalizar(nombre))?.[1];
                const limpio = String(dado ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
                if (limpio && !vistos.has(normalizar(limpio))) { vistos.add(normalizar(limpio)); values.push(limpio); }
            }
            return { name: nombre, values };
        });
        const variants = entrada.variants.map((v) => ({ sellerSku: String(v.sellerSku).trim(), values: valoresDeVariante(v.values, axes) }));
        if (variants.length < 2) throw new BadRequestException('Un producto con variantes necesita al menos dos.');
        if (new Set(variants.map((v) => claveDeCombinacion(v.values, axes))).size !== variants.length) throw new BadRequestException('Dos variantes tienen la misma combinación de valores: cada variante debe ser distinta.');

        return { parentSku: entrada.parentSku.trim(), name: entrada.name.trim(), axes, variants, origen: 'manual' };
    }

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
