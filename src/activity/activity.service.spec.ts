import { BadRequestException } from '@nestjs/common';
import { ActivityService } from './activity.service';
import { PrivacyService } from './privacy.service';
import { PRIVACY_VERSION } from './activity.constants';

const SESION = '7d6f1c9e-3b1a-4f0e-9d2a-5c8e0a1b2c3d';
const TIENDA = '1a2b3c4d-1111-4222-8333-444455556666';
const user = { id: 'u1', role: 'user' };

function construir(opts: { consentimiento?: boolean; rolEnTienda?: string | null; candado?: boolean } = {}) {
    const insertados: any[] = [];
    const eventos: any = { create: jest.fn((d: any) => ({ ...d })), insert: jest.fn(async (filas: any) => { insertados.push(...[].concat(filas)); }) };
    const miembros: any = { findOne: jest.fn(async () => (opts.rolEnTienda ? { role: opts.rolEnTienda } : null)) };
    const consultas: { sql: string; params: any[] }[] = [];
    const ds: any = { query: jest.fn(async (sql: string, params: any[]) => { consultas.push({ sql, params }); return [[], 3]; }) };
    const privacy: any = { tieneConsentimiento: jest.fn(async () => opts.consentimiento ?? true) };
    const redis: any = { set: jest.fn(async () => (opts.candado === false ? null : 'OK')) };
    const servicio = new ActivityService(eventos, miembros, ds, privacy, redis);
    return { servicio, insertados, consultas, eventos, miembros, privacy, redis, ds };
}
const lote = (extra: any = {}) => ({ sessionId: SESION, storeId: TIENDA, events: [{ t: 'view', screen: 'ventas' }, { t: 'click', screen: 'ventas', element: 'descargar', x: 100, y: 200 }, { t: 'ping', screen: 'ventas', v: 30 }], ...extra });

describe('registro de actividad del navegador', () => {
    it('sin aceptar el aviso de privacidad no se guarda NADA y se avisa para mostrarlo', async () => {
        const { servicio, insertados, ds } = construir({ consentimiento: false });
        const r = await servicio.registrarLote(user, lote());
        expect(r).toEqual({ registrados: 0, descartados: 0, requiereAviso: true });
        expect(insertados).toHaveLength(0);
        expect(ds.query).not.toHaveBeenCalled();
    });

    it('guarda cada evento con el rol de la persona en la plataforma y en la tienda, y anota la sesión con sus segundos', async () => {
        const { servicio, insertados, consultas } = construir({ rolEnTienda: 'editor' });
        const r = await servicio.registrarLote(user, lote());
        expect(r).toEqual({ registrados: 3, descartados: 0, requiereAviso: false });
        expect(insertados.map((e) => e.type)).toEqual(['view', 'click', 'ping']);
        expect(insertados[0]).toMatchObject({ userId: 'u1', storeId: TIENDA, sessionId: SESION, platformRole: 'user', storeRole: 'editor' });
        expect(insertados[1]).toMatchObject({ element: 'descargar', x: 100, y: 200 });
        const sesion = consultas[0];
        expect(sesion.sql).toContain('INSERT INTO activity_sessions');
        expect(sesion.sql).toContain('WHERE activity_sessions."userId" = EXCLUDED."userId"');
        expect(sesion.params[0]).toBe(SESION);
        expect(sesion.params[8]).toBe(30);
    });

    it('una tienda de la que la persona no es miembro no se le atribuye: la actividad queda sin tienda', async () => {
        const { servicio, insertados } = construir({ rolEnTienda: null });
        await servicio.registrarLote(user, lote());
        expect(insertados[0]).toMatchObject({ storeId: null, storeRole: '' });
    });

    it('un lote que no es válido se rechaza; uno sin eventos válidos no guarda nada', async () => {
        const { servicio, insertados } = construir();
        await expect(servicio.registrarLote(user, { sessionId: 'no-es-uuid', events: [] })).rejects.toThrow(BadRequestException);
        const r = await servicio.registrarLote(user, { sessionId: SESION, events: [{ t: 'raro' }] });
        expect(r).toMatchObject({ registrados: 0, descartados: 1 });
        expect(insertados).toHaveLength(0);
    });

    it('el rol de tienda se recuerda unos minutos (no se consulta en cada lote)', async () => {
        const { servicio, miembros } = construir({ rolEnTienda: 'owner' });
        await servicio.registrarLote(user, lote());
        await servicio.registrarLote(user, lote());
        expect(miembros.findOne).toHaveBeenCalledTimes(1);
    });
});

describe('acciones hechas en el servidor', () => {
    const ctx = { userId: 'u1', platformRole: 'user', storeId: TIENDA, storeRole: 'owner' };

    it('se anotan con su nombre y pantalla, solo si aceptó el aviso', async () => {
        const con = construir();
        await con.servicio.anotar(ctx, 'action', 'Registrar venta manual', 'ventas');
        expect(con.insertados[0]).toMatchObject({ type: 'action', action: 'Registrar venta manual', screen: 'ventas', element: null, storeRole: 'owner', platformRole: 'user' });
        const sin = construir({ consentimiento: false });
        await sin.servicio.anotar(ctx, 'login', 'Inicio de sesión', 'cuenta');
        expect(sin.insertados).toHaveLength(0);
    });

    it('si la base falla no lanza: anotar la actividad nunca rompe lo que se estaba haciendo', async () => {
        const { servicio, eventos } = construir();
        eventos.insert.mockRejectedValue(new Error('base caída'));
        await expect(servicio.anotar(ctx, 'action', 'x', 'ventas')).resolves.toBeUndefined();
    });
});

describe('resúmenes y limpieza', () => {
    it('refrescar recalcula los días indicados y es repetible (no duplica)', async () => {
        const { servicio, consultas } = construir();
        await servicio.refrescarResumenes(2);
        expect(consultas).toHaveLength(2);
        expect(consultas[0].sql).toContain('INSERT INTO activity_daily');
        expect(consultas[0].sql).toContain('ON CONFLICT ON CONSTRAINT "UQ_activity_daily" DO UPDATE');
        expect(consultas[1].sql).toContain('INSERT INTO activity_hourly');
        expect(consultas[0].params).toEqual([2]);
    });

    it('antes de leer se pone al día a lo más una vez por minuto', async () => {
        const { servicio, ds } = construir();
        await servicio.refrescarSiHaceFalta();
        await servicio.refrescarSiHaceFalta();
        expect(ds.query).toHaveBeenCalledTimes(2); // una vez: diario + horario
    });

    it('la limpieza borra el detalle a los 90 días y los resúmenes y sesiones a los 2 años', async () => {
        const { servicio, consultas } = construir();
        await servicio.limpiar();
        const sql = consultas.map((c) => c.sql).join('\n');
        expect(consultas[0].params).toEqual([90]);
        expect(sql).toContain('DELETE FROM activity_events');
        expect(sql).toContain('DELETE FROM activity_daily');
        expect(sql).toContain('DELETE FROM activity_hourly');
        expect(sql).toContain('DELETE FROM activity_sessions');
        expect(consultas.slice(1).some((c) => c.params[0] === 730)).toBe(true);
    });

    it('el mantenimiento recalcula todo el detalle guardado ANTES de borrar, y solo una réplica lo hace', async () => {
        const { servicio, consultas } = construir();
        await servicio.mantenimiento();
        const orden = consultas.map((c) => c.sql.trim().split(/\s+/).slice(0, 3).join(' '));
        expect(orden.indexOf('INSERT INTO activity_daily')).toBeLessThan(orden.indexOf('DELETE FROM activity_events'));
        expect(consultas[0].params).toEqual([95]);

        const otra = construir({ candado: false });
        await otra.servicio.mantenimiento();
        expect(otra.ds.query).not.toHaveBeenCalled();
    });
});

describe('aviso de privacidad (versión y recuerdo)', () => {
    it('recuerda la respuesta, la guarda con la versión vigente y avisa si falta', async () => {
        const repo: any = {
            findOne: jest.fn(async () => null),
            createQueryBuilder: jest.fn(() => ({ insert: () => ({ values: (v: any) => { repo.valores = v; return { orIgnore: () => ({ execute: async () => undefined }) }; } }) })),
        };
        const privacidad = new PrivacyService(repo);
        expect(await privacidad.estado('u9')).toEqual({ version: PRIVACY_VERSION, accepted: false });
        await privacidad.aceptar('u9', 'registro');
        expect(repo.valores).toEqual({ userId: 'u9', version: PRIVACY_VERSION, via: 'registro' });
        expect(await privacidad.tieneConsentimiento('u9')).toBe(true);
        expect(repo.findOne).toHaveBeenCalledTimes(1);
    });
});
