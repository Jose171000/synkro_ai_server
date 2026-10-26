import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Índices únicos del SKU. El nombre «sku» va en cada uno: ProductsService reconoce así el rechazo de la base. */
export const INDICE_SKU_POR_TIENDA = 'UQ_product_sku_store';
export const INDICE_SKU_SIN_TIENDA = 'UQ_product_sku_owner_sin_tienda';
const RESTRICCION_ANTIGUA = 'UQ_product_sku_owner';
export const RESTRICCION_SKU_NO_VACIO = 'CHK_product_sku_no_vacio';

/**
 * Garantiza en la base de datos que un SKU no se repite dentro de una tienda, sin distinguir mayúsculas ni espacios
 * (el control del código no basta: dos cargas a la vez pasan la revisión previa y guardan las dos).
 *
 * - Productos con tienda: único `(tienda, SKU normalizado)`.
 * - Productos sin tienda (anteriores a las tiendas): único `(dueño, SKU normalizado)` entre los que no tienen tienda.
 *
 * Se aplica al arrancar y es idempotente. Si ya hay SKU repetidos no se puede crear el índice: no se cae el servidor ni se
 * tocan los datos; se avisa en el registro con los repetidos y se vuelve a intentar en el siguiente arranque. La
 * restricción antigua `(sku, dueño)` solo se quita cuando los dos índices nuevos ya existen, porque impide que dos
 * tiendas de una misma cuenta usen el mismo SKU.
 */
@Injectable()
export class SkuUnicoService implements OnApplicationBootstrap {
    private readonly logger = new Logger(SkuUnicoService.name);

    constructor(private readonly dataSource: DataSource) { }

    async onApplicationBootstrap(): Promise<void> {
        try {
            await this.aplicar();
            await this.aplicarNoVacio();
        } catch (error: any) {
            // Nunca debe impedir que el servidor arranque.
            this.logger.warn(`No se pudo comprobar la unicidad del SKU: ${error?.message}`);
        }
    }

    async aplicar(): Promise<{ aplicado: boolean; repetidos: { ambito: string; sku: string; cantidad: number }[] }> {
        const repetidos = await this.buscarRepetidos();
        if (repetidos.length) {
            this.logger.warn(
                `Hay SKU repetidos dentro de una misma tienda; no se puede garantizar la unicidad en la base hasta resolverlos ` +
                `(${repetidos.length} casos, primeros: ${repetidos.slice(0, 10).map(r => `${r.sku} ×${r.cantidad} [${r.ambito}]`).join(', ')}). ` +
                `Cambia o elimina los duplicados y reinicia el servidor.`,
            );
            return { aplicado: false, repetidos };
        }

        await this.dataSource.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "${INDICE_SKU_POR_TIENDA}" ON "products" ("storeId", lower(btrim("sku"))) WHERE "storeId" IS NOT NULL`,
        );
        await this.dataSource.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "${INDICE_SKU_SIN_TIENDA}" ON "products" ("ownerId", lower(btrim("sku"))) WHERE "storeId" IS NULL`,
        );
        await this.dataSource.query(`ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "${RESTRICCION_ANTIGUA}"`);
        this.logger.log('Unicidad del SKU garantizada por tienda en la base de datos.');
        return { aplicado: true, repetidos: [] };
    }

    /**
     * Un producto no puede tener el SKU vacío (sin SKU no se enlaza con ningún canal). La regla se crea en la base solo
     * cuando ya no queda ninguno así: con una restricción activa, cualquier actualización de un producto sin SKU (su stock,
     * por ejemplo) sería rechazada. Mientras haya alguno se avisa en el registro con sus nombres y se reintenta al arrancar.
     */
    async aplicarNoVacio(): Promise<{ aplicado: boolean; sinSku: { id: string; name: string }[] }> {
        const sinSku: { id: string; name: string }[] = await this.dataSource.query(
            `SELECT "id", "name" FROM "products" WHERE btrim("sku") = '' OR "sku" IS NULL ORDER BY "name" LIMIT 50`,
        );
        if (sinSku.length) {
            const nombres = sinSku.slice(0, 10).map(p => `${p.name} [${p.id}]`).join(', ');
            this.logger.warn(
                `Hay productos sin SKU (${sinSku.length}): ${nombres}. ` +
                `Ponles un SKU y reinicia el servidor para activar la regla de SKU no vacío.`,
            );
            return { aplicado: false, sinSku };
        }
        const existe: unknown[] = await this.dataSource.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [RESTRICCION_SKU_NO_VACIO]);
        if (!existe.length) {
            await this.dataSource.query(`ALTER TABLE "products" ADD CONSTRAINT "${RESTRICCION_SKU_NO_VACIO}" CHECK (btrim("sku") <> '')`);
            this.logger.log('Regla de SKU no vacío activada en la base de datos.');
        }
        return { aplicado: true, sinSku: [] };
    }

    /** SKU que se repiten dentro de su ámbito: la tienda, o el dueño para los productos sin tienda. */
    async buscarRepetidos(): Promise<{ ambito: string; sku: string; cantidad: number }[]> {
        const filas: { ambito: string; sku: string; cantidad: string }[] = await this.dataSource.query(
            `SELECT COALESCE('tienda ' || "storeId"::text, 'dueño ' || "ownerId"::text) AS ambito,
                    lower(btrim("sku")) AS sku,
                    count(*) AS cantidad
               FROM "products"
              GROUP BY 1, 2
             HAVING count(*) > 1
              ORDER BY count(*) DESC
              LIMIT 200`,
        );
        return filas.map(f => ({ ambito: f.ambito, sku: f.sku, cantidad: Number(f.cantidad) }));
    }
}
