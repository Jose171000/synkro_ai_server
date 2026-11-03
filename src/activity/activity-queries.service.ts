import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { condicionesSql, FiltroDeActividad } from './activity-filter';
import { ROLES_DE_PLATAFORMA, ROLES_DE_TIENDA, ZONA_HORARIA } from './activity.constants';

const num = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (v: unknown) => Math.round(num(v) * 100) / 100;

/**
 * Consultas de Superadmin › Actividad. Leen los resúmenes por día y por hora (no el detalle), así que sirven igual para 7
 * días que para 2 años. Con «todos» y modo promedio, cada persona pesa lo mismo: quien más usa la plataforma no tapa a los
 * demás.
 */
@Injectable()
export class ActivityQueriesService {
    constructor(private readonly ds: DataSource) { }

    private async q<T = any>(sql: string, params: unknown[]): Promise<T[]> {
        return this.ds.query(sql, params);
    }

    /** Cuántas personas tuvieron actividad con estos filtros (el divisor del promedio). */
    async usuarios(f: FiltroDeActividad): Promise<number> {
        const p: unknown[] = [];
        const [fila] = await this.q(`SELECT count(DISTINCT d."userId")::int AS n FROM activity_daily d WHERE ${condicionesSql(f, 'd', p)}`, p);
        return num(fila?.n);
    }

    async resumen(f: FiltroDeActividad) {
        const usuarios = await this.usuarios(f);
        const p1: unknown[] = [];
        const tipos = await this.q(`SELECT d.type, sum(d.n)::int AS n FROM activity_daily d WHERE ${condicionesSql(f, 'd', p1)} GROUP BY d.type`, p1);
        const por = (t: string) => num(tipos.find((x) => x.type === t)?.n);

        const p2: unknown[] = [];
        const [ses] = await this.q(
            `SELECT count(*)::int AS sesiones, max(s."lastSeenAt") AS ultimo
               FROM activity_sessions s WHERE ${condicionesSql(f, 's', p2, `(s."startedAt" AT TIME ZONE '${ZONA_HORARIA}')::date`)}`, p2);
        const p3: unknown[] = [];
        const [hor] = await this.q(`SELECT COALESCE(sum(h.seconds), 0)::int AS seg FROM activity_hourly h WHERE ${condicionesSql(f, 'h', p3)}`, p3);

        const total = { sesiones: num(ses?.sesiones), segundosActivos: num(hor?.seg), vistas: por('view'), clics: por('click'), acciones: por('action'), ingresos: por('login') };
        const dividir = f.promedio && usuarios > 0 ? usuarios : 1;
        return {
            usuarios,
            promedio: f.promedio,
            total,
            /** Lo que corresponde en promedio a cada persona (igual al total cuando es una sola). */
            porUsuario: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, r2(v / dividir)])),
            ultimoIngreso: f.userId ? ses?.ultimo ?? null : null,
        };
    }

    /** Ranking de pantallas o de funciones: participación promedio de cada persona (o el total, según el modo). */
    private async ranking(f: FiltroDeActividad, tipo: 'view' | 'action') {
        const p: unknown[] = [tipo];
        const dondeSql = condicionesSql(f, 'd', p);
        const clave = tipo === 'view' ? 'd.screen' : `d.element`;
        const filas = await this.q(
            `WITH v AS (SELECT d."userId", ${clave} AS nombre, sum(d.n)::float AS n FROM activity_daily d WHERE d.type = $1 AND ${dondeSql} GROUP BY 1, 2),
                  t AS (SELECT "userId", sum(n) AS tot FROM v GROUP BY 1),
                  u AS (SELECT count(DISTINCT d."userId")::float AS n FROM activity_daily d WHERE ${dondeSql.replace(/\$(\d+)/g, (_, i) => `$${Number(i)}`)})
             SELECT v.nombre, sum(v.n)::int AS total, sum(v.n / t.tot) / NULLIF((SELECT n FROM u), 0) AS participacion, count(*)::int AS usuarios
               FROM v JOIN t USING ("userId") GROUP BY v.nombre ORDER BY ${f.promedio ? 'participacion' : 'total'} DESC LIMIT 30`,
            p,
        );
        const max = Math.max(0, ...filas.map((x) => (f.promedio ? num(x.participacion) : num(x.total))));
        return filas.map((x) => ({
            nombre: x.nombre,
            total: num(x.total),
            usuarios: num(x.usuarios),
            /** 0-100: participación promedio de cada persona (o el total relativo al mayor). */
            porcentaje: f.promedio ? r2(num(x.participacion) * 100) : (max ? r2((num(x.total) / max) * 100) : 0),
        }));
    }

    secciones(f: FiltroDeActividad) { return this.ranking(f, 'view'); }
    funciones(f: FiltroDeActividad) { return this.ranking(f, 'action'); }

    /** Actividad por día de la semana (1 = lunes … 7 = domingo) y hora (Lima). */
    async horas(f: FiltroDeActividad) {
        const usuarios = await this.usuarios(f);
        const p: unknown[] = [];
        const filas = await this.q(
            `SELECT EXTRACT(ISODOW FROM h.day)::int AS dia, h.hour::int AS hora, sum(h.events)::int AS eventos, sum(h.seconds)::int AS segundos
               FROM activity_hourly h WHERE ${condicionesSql(f, 'h', p)} GROUP BY 1, 2`, p);
        const dividir = f.promedio && usuarios > 0 ? usuarios : 1;
        return filas.map((x) => ({ dia: num(x.dia), hora: num(x.hora), eventos: num(x.eventos), segundos: num(x.segundos), valor: r2(num(x.eventos) / dividir) }));
    }

    /** Lo último que hizo una persona (vistas, acciones e ingresos; los latidos no). */
    async linea(userId: string, f: FiltroDeActividad) {
        const filas = await this.q(
            `SELECT e.at, e.type, e.screen, e.element, e.action FROM activity_events e
              WHERE e."userId" = $1::uuid AND e.type <> 'ping' AND e.type <> 'click'
                AND (e.at AT TIME ZONE '${ZONA_HORARIA}')::date BETWEEN $2::date AND $3::date
              ORDER BY e.at DESC LIMIT 100`, [userId, f.desde, f.hasta]);
        return filas.map((x) => ({ at: x.at, tipo: x.type, pantalla: x.screen, elemento: x.element, accion: x.action }));
    }

    /** Pantallas donde hubo clics: son las que tienen mapa de calor. */
    async pantallas(f: FiltroDeActividad) {
        const p: unknown[] = [];
        const filas = await this.q(
            `SELECT d.screen, sum(d.n) FILTER (WHERE d.type = 'click')::int AS clics, count(DISTINCT d."userId") FILTER (WHERE d.type = 'click')::int AS usuarios,
                    sum(d.n) FILTER (WHERE d.type = 'view')::int AS vistas
               FROM activity_daily d WHERE ${condicionesSql(f, 'd', p)} AND d.type IN ('click', 'view')
              GROUP BY d.screen HAVING sum(d.n) FILTER (WHERE d.type = 'click') > 0 ORDER BY clics DESC`, p);
        return filas.map((x) => ({ pantalla: x.screen, clics: num(x.clics), usuarios: num(x.usuarios), vistas: num(x.vistas) }));
    }

    /**
     * Mapa de clics de una pantalla: cada elemento con sus clics, cuántas personas lo tocaron, su posición media en la
     * pantalla (milésimas) y su participación. En modo promedio, el mapa de cada persona se normaliza y luego se promedia.
     */
    async clics(f: FiltroDeActividad, pantalla: string) {
        const p: unknown[] = [pantalla];
        const dondeSql = condicionesSql(f, 'd', p);
        const filas = await this.q(
            `WITH c AS (
                 SELECT d."userId", d.element, sum(d.n)::float AS n,
                        sum(d.ex * d.n) FILTER (WHERE d.ex IS NOT NULL) / NULLIF(sum(d.n) FILTER (WHERE d.ex IS NOT NULL), 0) AS ex,
                        sum(d.ey * d.n) FILTER (WHERE d.ey IS NOT NULL) / NULLIF(sum(d.n) FILTER (WHERE d.ey IS NOT NULL), 0) AS ey,
                        sum(d.ew * d.n) FILTER (WHERE d.ew IS NOT NULL) / NULLIF(sum(d.n) FILTER (WHERE d.ew IS NOT NULL), 0) AS ew,
                        sum(d.eh * d.n) FILTER (WHERE d.eh IS NOT NULL) / NULLIF(sum(d.n) FILTER (WHERE d.eh IS NOT NULL), 0) AS eh
                   FROM activity_daily d WHERE d.type = 'click' AND d.screen = $1 AND d.element <> '' AND ${dondeSql} GROUP BY 1, 2),
                 t AS (SELECT "userId", sum(n) AS tot FROM c GROUP BY 1)
             SELECT c.element, sum(c.n)::int AS clics, count(*)::int AS usuarios,
                    sum(c.n / t.tot) / NULLIF((SELECT count(*) FROM t), 0) AS participacion,
                    sum(c.ex * c.n) / NULLIF(sum(c.n) FILTER (WHERE c.ex IS NOT NULL), 0) AS ex,
                    sum(c.ey * c.n) / NULLIF(sum(c.n) FILTER (WHERE c.ey IS NOT NULL), 0) AS ey,
                    sum(c.ew * c.n) / NULLIF(sum(c.n) FILTER (WHERE c.ew IS NOT NULL), 0) AS ew,
                    sum(c.eh * c.n) / NULLIF(sum(c.n) FILTER (WHERE c.eh IS NOT NULL), 0) AS eh
               FROM c JOIN t USING ("userId") GROUP BY c.element ORDER BY ${f.promedio ? 'participacion' : 'clics'} DESC LIMIT 200`,
            p,
        );
        const max = Math.max(0, ...filas.map((x) => (f.promedio ? num(x.participacion) : num(x.clics))));
        const posicion = (v: unknown) => (v === null || v === undefined ? null : Math.round(num(v)));
        return filas.map((x) => ({
            elemento: x.element,
            clics: num(x.clics),
            usuarios: num(x.usuarios),
            participacion: r2(num(x.participacion) * 100),
            /** 0-1: qué tan «caliente» es respecto al elemento más tocado. */
            intensidad: max ? Math.round(((f.promedio ? num(x.participacion) : num(x.clics)) / max) * 1000) / 1000 : 0,
            rect: posicion(x.ex) === null ? null : { x: posicion(x.ex), y: posicion(x.ey), w: posicion(x.ew), h: posicion(x.eh) },
        }));
    }

    /** Plano de una pantalla (forma de sus bloques) o null si todavía nadie lo mandó. No depende de los filtros: no es de nadie. */
    async plano(pantalla: string) {
        const [f] = await this.q(`SELECT blocks, width, height, "capturedAt" FROM activity_layouts WHERE screen = $1`, [pantalla]);
        return f ? { bloques: f.blocks, ancho: num(f.width), alto: num(f.height), tomadoEl: f.capturedAt } : null;
    }

    /** Resumen por persona con los filtros puestos, de la más activa a la menos activa. */
    async personas(f: FiltroDeActividad) {
        const pd: unknown[] = [];
        const dD = condicionesSql(f, 'd', pd);
        const ph: unknown[] = [];
        const dH = condicionesSql(f, 'h', ph);
        const ps: unknown[] = [];
        const dS = condicionesSql(f, 's', ps, `(s."startedAt" AT TIME ZONE '${ZONA_HORARIA}')::date`);
        const [acc, seg, ses] = await Promise.all([
            this.q(`SELECT d."userId", sum(d.n) FILTER (WHERE d.type = 'action')::int AS acciones, sum(d.n) FILTER (WHERE d.type = 'click')::int AS clics, max(d."platformRole") AS rol_plataforma, max(NULLIF(d."storeRole", '')) AS rol_tienda FROM activity_daily d WHERE ${dD} GROUP BY 1`, pd),
            this.q(`SELECT h."userId", sum(h.seconds)::int AS segundos FROM activity_hourly h WHERE ${dH} GROUP BY 1`, ph),
            this.q(`SELECT s."userId", count(*)::int AS sesiones, max(s."lastSeenAt") AS ultimo FROM activity_sessions s WHERE ${dS} GROUP BY 1`, ps),
        ]);
        const ids = [...new Set([...acc.map((x) => x.userId), ...seg.map((x) => x.userId), ...ses.map((x) => x.userId)])];
        if (!ids.length) return [];
        const usuarios = await this.q(`SELECT u.id, u.name, u."lastName", u.email FROM users u WHERE u.id = ANY($1::uuid[])`, [ids]);
        return ids.map((id) => {
            const u = usuarios.find((x) => x.id === id);
            const a = acc.find((x) => x.userId === id), s = seg.find((x) => x.userId === id), e = ses.find((x) => x.userId === id);
            return {
                userId: id,
                nombre: u ? `${u.name} ${u.lastName}`.trim() : 'Usuario eliminado',
                correo: u?.email ?? null,
                rolPlataforma: a?.rol_plataforma ?? null,
                rolTienda: a?.rol_tienda ?? null,
                sesiones: num(e?.sesiones),
                segundosActivos: num(s?.segundos),
                acciones: num(a?.acciones),
                clics: num(a?.clics),
                ultimoIngreso: e?.ultimo ?? null,
            };
        }).sort((x, y) => y.segundosActivos + y.acciones * 30 - (x.segundosActivos + x.acciones * 30));
    }

    /** Opciones de los selectores: roles disponibles y las personas con actividad. */
    async opciones() {
        const usuarios = await this.q(
            `SELECT u.id, u.name, u."lastName", u.email, u.role FROM users u
              WHERE EXISTS (SELECT 1 FROM activity_daily d WHERE d."userId" = u.id) ORDER BY u.name LIMIT 500`, []);
        return {
            rolesPlataforma: ROLES_DE_PLATAFORMA,
            rolesTienda: ROLES_DE_TIENDA,
            usuarios: usuarios.map((u) => ({ id: u.id, nombre: `${u.name} ${u.lastName}`.trim(), correo: u.email, rol: u.role })),
        };
    }
}
