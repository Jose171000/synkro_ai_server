import { atribuirTiendas } from './client-stores';

/**
 * La agencia crea las tiendas de sus clientes desde sus propias cuentas: el
 * dueño de la tienda no dice de quién es el negocio. Lo que se protege: lo
 * asignado a mano manda, una cuenta normal es dueña de lo suyo, el nombre del
 * negocio reconoce la tienda, y jamás se adivina entre dos clientes.
 */
const tienda = (id: string, nombre: string, duenoId: string, duenoRol = 'user', clienteAsignadoId: string | null = null) =>
    ({ id, nombre, duenoId, duenoRol, clienteAsignadoId });

const clientes = [
    { id: 'c1', nombres: ['Corporación Médica', 'Corpomedic SAC', 'Jose Reategui'] },
    { id: 'c2', nombres: ['NodoShop', '', 'Irma Centurion'] },
    { id: 'c3', nombres: ['Laihome', 'Katherine Seminario'] },
];

describe('atribuir tiendas a clientes', () => {
    it('lo asignado a mano manda sobre todo lo demás', () => {
        const r = atribuirTiendas([tienda('t1', 'Corporación Médica', 'admin1', 'admin', 'c2')], clientes);
        expect(r.get('t1')).toEqual({ clienteId: 'c2', origen: 'asignada' });
    });

    it('una tienda cuyo dueño es el propio cliente es del cliente', () => {
        const r = atribuirTiendas([tienda('t1', 'Mi tienda', 'c3')], clientes);
        expect(r.get('t1')).toEqual({ clienteId: 'c3', origen: 'dueno' });
    });

    it('una tienda a nombre de un superadmin se reconoce por el nombre del negocio, sin tildes ni mayúsculas', () => {
        const r = atribuirTiendas([tienda('t1', 'CORPORACION MEDICA', 'admin1', 'admin')], clientes);
        expect(r.get('t1')).toEqual({ clienteId: 'c1', origen: 'nombre' });
    });

    it('también por la razón social o el nombre de la empresa', () => {
        const r = atribuirTiendas([tienda('t1', 'corpomedic sac', 'admin1', 'admin')], clientes);
        expect(r.get('t1')?.clienteId).toBe('c1');
    });

    it('una tienda de un superadmin que no coincide con ningún cliente queda sin asignar', () => {
        const r = atribuirTiendas([tienda('t1', 'José - Prueba Reátegui', 'admin1', 'admin')], clientes);
        expect(r.has('t1')).toBe(false);
    });

    it('si dos clientes se llaman igual no se adivina', () => {
        const repetidos = [{ id: 'a', nombres: ['Rivesi'] }, { id: 'b', nombres: ['rivesi'] }];
        expect(atribuirTiendas([tienda('t1', 'Rivesi', 'admin1', 'admin')], repetidos).has('t1')).toBe(false);
    });

    it('el mismo cliente con varios nombres iguales no cuenta como duplicado', () => {
        const uno = [{ id: 'a', nombres: ['Rivesi', 'RIVESI', 'rivesi '] }];
        expect(atribuirTiendas([tienda('t1', 'Rivesi', 'admin1', 'admin')], uno).get('t1')?.clienteId).toBe('a');
    });

    it('un superadmin no es dueño de «lo suyo» como cliente aunque esté en la lista', () => {
        const conAdmin = [...clientes, { id: 'admin1', nombres: ['Agencia'] }];
        expect(atribuirTiendas([tienda('t1', 'Otra', 'admin1', 'admin')], conAdmin).has('t1')).toBe(false);
    });

    it('varias tiendas del mismo cliente se atribuyen todas', () => {
        const r = atribuirTiendas([tienda('t1', 'Laihome', 'admin1', 'admin'), tienda('t2', 'Otra', 'admin1', 'admin', 'c3')], clientes);
        expect([...r.entries()].filter(([, v]) => v.clienteId === 'c3').map(([k]) => k).sort()).toEqual(['t1', 't2']);
    });
});
