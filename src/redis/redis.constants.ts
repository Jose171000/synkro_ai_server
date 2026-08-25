/**
 * Token del cliente de Redis en su propio archivo: si viviera en
 * redis.module.ts, cualquier proveedor que lo inyecte y a la vez sea
 * declarado por ese módulo crearía una importación circular.
 */
export const REDIS_CLIENT = 'REDIS_CLIENT';
