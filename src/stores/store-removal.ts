import { EntityManager } from 'typeorm';

/**
 * Borra una tienda con todo lo que cuelga de ella: ventas, productos (con sus
 * imágenes y publicaciones), canales conectados y lo que de ellos depende.
 * Los miembros, las invitaciones y las solicitudes de revisión se van con la
 * tienda. Los pagos registrados se conservan (quedan sin tienda): son el
 * historial de lo cobrado.
 *
 * Debe ejecutarse dentro de una transacción: o se borra todo, o no se borra nada.
 * Se hace con SQL directo para no depender de cómo estén declaradas las cascadas
 * de cada entidad (varias son «poner en nulo», que dejaría datos huérfanos).
 */
export interface ResumenDeBorrado {
    pedidos: number;
    productos: number;
    canales: number;
}

export async function eliminarTienda(manager: EntityManager, storeId: string): Promise<ResumenDeBorrado> {
    const borrar = async (sql: string): Promise<number> => {
        const filas = await manager.query(`${sql} RETURNING 1`, [storeId]);
        return Array.isArray(filas) ? (Array.isArray(filas[0]) ? filas[0].length : filas.length) : 0;
    };

    const pedidos = await borrar(`DELETE FROM marketplace_orders WHERE "storeId" = $1`);
    await borrar(`DELETE FROM marketplace_feeds WHERE "connectionId" IN (SELECT id FROM marketplace_connections WHERE "storeId" = $1)`);
    await borrar(
        `DELETE FROM listing_links WHERE "connectionId" IN (SELECT id FROM marketplace_connections WHERE "storeId" = $1)
            OR "productId" IN (SELECT id FROM products WHERE "storeId" = $1)`,
    );
    await borrar(`DELETE FROM sync_change_requests WHERE "storeId" = $1`);
    const productos = await borrar(`DELETE FROM products WHERE "storeId" = $1`);
    const canales = await borrar(`DELETE FROM marketplace_connections WHERE "storeId" = $1`);
    await borrar(`DELETE FROM stores WHERE id = $1`);

    return { pedidos, productos, canales };
}
