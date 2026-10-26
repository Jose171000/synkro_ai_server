import { grupoDeClave, repartirPorGrupo } from './redis-diagnostico';

/**
 * El diagnóstico reparte las claves de Redis por tipo: el historial de trabajos (completados, fallidos y el detalle de
 * cada uno) se distingue de los trabajos pendientes y de lo demás que guarda la aplicación.
 */
describe('grupoDeClave', () => {
    it.each([
        ['bull:marketplace-sync-queue:completed', 'bull:marketplace-sync-queue:completed'],
        ['bull:marketplace-sync-queue:failed', 'bull:marketplace-sync-queue:failed'],
        ['bull:marketplace-sync-queue:wait', 'bull:marketplace-sync-queue:wait'],
        ['bull:marketplace-sync-queue:delayed', 'bull:marketplace-sync-queue:delayed'],
        ['bull:marketplace-sync-queue:events', 'bull:marketplace-sync-queue:events'],
        ['bull:marketplace-sync-queue:12345', 'bull:marketplace-sync-queue:trabajos'],
        ['bull:marketplace-sync-queue:12345:logs', 'bull:marketplace-sync-queue:trabajos'],
        ['bull:marketplace-sync-queue:content-p1-c1', 'bull:marketplace-sync-queue:trabajos'],
        ['batch:3f2a9c8e-1111-2222-3333-444455556666', 'batch'],
        ['ia-ejes:0123456789abcdef0123456789abcdef01234567', 'ia-ejes'],
        ['feed-procesado:3f2a9c8e-1111', 'feed-procesado'],
    ])('%s → %s', (clave, grupo) => {
        expect(grupoDeClave(clave)).toBe(grupo);
    });

    it('reparte una lista de claves en grupos', () => {
        const grupos = repartirPorGrupo(['bull:q:1', 'bull:q:2', 'bull:q:completed', 'batch:x']);
        expect([...grupos.entries()].map(([g, l]) => [g, l.length])).toEqual([['bull:q:trabajos', 2], ['bull:q:completed', 1], ['batch', 1]]);
    });
});
