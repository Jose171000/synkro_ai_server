import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { StoreMember } from '../stores/entities/store-member.entity';
import { ActivityEvent } from './entities/activity.entities';
import { PrivacyService } from './privacy.service';
import { validarLote, LoteValido } from './activity-validation';
import { DIAS_DE_DETALLE, DIAS_DE_RESUMEN, ZONA_HORARIA } from './activity.constants';

export interface ContextoDeActividad {
    userId: string;
    platformRole: string;
    storeId?: string | null;
    storeRole?: string | null;
}

const SEIS_HORAS = 6 * 3600_000;

/**
 * Registro de la actividad de los usuarios: lo que mandan sus navegadores (vistas, clics, latidos) y lo que hacen en el
 * servidor (acciones). Solo se anota de quien aceptó el aviso de privacidad vigente. Nunca lanza: un fallo aquí no debe
 * romper lo que la persona estaba haciendo.
 */
@Injectable()
export class ActivityService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ActivityService.name);
    private readonly roles = new Map<string, { rol: string | null; hasta: number }>();
    private ultimoResumen = 0;
    private temporizadores: NodeJS.Timeout[] = [];

    constructor(
        @InjectRepository(ActivityEvent) private readonly eventos: Repository<ActivityEvent>,
        @InjectRepository(StoreMember) private readonly miembros: Repository<StoreMember>,
        private readonly ds: DataSource,
        private readonly privacy: PrivacyService,
        @Inject(REDIS_CLIENT) private readonly redis: Redis,
    ) { }

    // ── Mantenimiento programado ──────────────────────────────────────────

    onModuleInit() {
        if (process.env.JEST_WORKER_ID) return;
        const primera = setTimeout(() => void this.mantenimiento(), 90_000);
        const cada = setInterval(() => void this.mantenimiento(), SEIS_HORAS);
        primera.unref?.(); cada.unref?.();
        this.temporizadores.push(primera, cada);
    }

    onModuleDestroy() {
        this.temporizadores.forEach(clearTimeout);
    }

    // ── Registro ──────────────────────────────────────────────────────────

    /** Rol de la persona en una tienda, o null si no es miembro. Se recuerda unos minutos. */
    private async rolEnTienda(userId: string, storeId: string): Promise<string | null> {
        const clave = `${userId}|${storeId}`;
        const guardado = this.roles.get(clave);
        if (guardado && guardado.hasta > Date.now()) return guardado.rol;
        const m = await this.miembros.findOne({ where: { user: { id: userId }, store: { id: storeId } } });
        const rol = m?.role ?? null;
        this.roles.set(clave, { rol, hasta: Date.now() + 5 * 60_000 });
        return rol;
    }

    /** Guarda un lote de eventos del navegador. Sin aceptación del aviso no guarda nada y avisa para que se muestre. */
    async registrarLote(user: { id: string; role: string }, body: any): Promise<{ registrados: number; descartados: number; requiereAviso: boolean }> {
        if (!(await this.privacy.tieneConsentimiento(user.id))) return { registrados: 0, descartados: 0, requiereAviso: true };
        const lote = validarLote(body);
        if (!lote) throw new BadRequestException('El lote de actividad no es válido.');
        if (!lote.eventos.length) return { registrados: 0, descartados: lote.descartados, requiereAviso: false };

        // Solo se anota una tienda de la que la persona es miembro: no se puede atribuir actividad a una ajena.
        const rolTienda = lote.storeId ? await this.rolEnTienda(user.id, lote.storeId) : null;
        const storeId = rolTienda ? lote.storeId : null;
        const rolDeTienda = rolTienda ?? '';

        await this.eventos.insert(lote.eventos.map((e) => this.eventos.create({
            userId: user.id, storeId, sessionId: lote.sessionId, at: e.at, type: e.type, screen: e.screen, element: e.element, action: null,
            x: e.x, y: e.y, ex: e.ex, ey: e.ey, ew: e.ew, eh: e.eh, value: e.value, platformRole: user.role, storeRole: rolDeTienda,
        })));
        await this.anotarSesion(user, lote, storeId, rolDeTienda);
        return { registrados: lote.eventos.length, descartados: lote.descartados, requiereAviso: false };
    }

    private async anotarSesion(user: { id: string; role: string }, lote: LoteValido, storeId: string | null, storeRole: string) {
        const horas = lote.eventos.map((e) => e.at.getTime());
        const segundos = lote.eventos.reduce((s, e) => s + (e.type === 'ping' ? e.value ?? 0 : 0), 0);
        await this.ds.query(
            `INSERT INTO activity_sessions (id, "userId", "storeId", "platformRole", "storeRole", device, "startedAt", "lastSeenAt", "activeSeconds")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
                "lastSeenAt" = GREATEST(activity_sessions."lastSeenAt", EXCLUDED."lastSeenAt"),
                "activeSeconds" = activity_sessions."activeSeconds" + EXCLUDED."activeSeconds"
             WHERE activity_sessions."userId" = EXCLUDED."userId"`,
            [lote.sessionId, user.id, storeId, user.role, storeRole, lote.device, new Date(Math.min(...horas)), new Date(Math.max(...horas)), segundos],
        );
    }

    /** Anota una acción hecha en el servidor (o un ingreso). No lanza nunca. */
    async anotar(ctx: ContextoDeActividad, tipo: 'action' | 'login', accion: string, pantalla: string): Promise<void> {
        try {
            if (!ctx.userId || !(await this.privacy.tieneConsentimiento(ctx.userId))) return;
            await this.eventos.insert(this.eventos.create({
                userId: ctx.userId, storeId: ctx.storeId ?? null, sessionId: null, at: new Date(), type: tipo, screen: pantalla.slice(0, 60),
                element: null, action: accion.slice(0, 120), x: null, y: null, ex: null, ey: null, ew: null, eh: null, value: null,
                platformRole: ctx.platformRole || 'user', storeRole: ctx.storeRole ?? '',
            }));
        } catch (error: any) {
            this.logger.warn(`No se pudo anotar la actividad: ${error?.message}`);
        }
    }

    // ── Resúmenes y limpieza ──────────────────────────────────────────────

    /** Recalcula los resúmenes por día y por hora de los últimos `dias` días (se puede repetir sin duplicar). */
    async refrescarResumenes(dias: number): Promise<void> {
        const desde = `((date_trunc('day', now() AT TIME ZONE '${ZONA_HORARIA}') - make_interval(days => $1)) AT TIME ZONE '${ZONA_HORARIA}')`;
        await this.ds.query(
            `INSERT INTO activity_daily (day, "userId", "platformRole", "storeRole", type, screen, element, n, ex, ey, ew, eh)
             SELECT (e.at AT TIME ZONE '${ZONA_HORARIA}')::date, e."userId", e."platformRole", e."storeRole", e.type, e.screen,
                    COALESCE(e.element, e.action, ''), count(*)::int,
                    round(avg(e.ex))::smallint, round(avg(e.ey))::smallint, round(avg(e.ew))::smallint, round(avg(e.eh))::smallint
               FROM activity_events e
              WHERE e.at >= ${desde} AND e.type IN ('view', 'click', 'action', 'login')
              GROUP BY 1, 2, 3, 4, 5, 6, 7
             ON CONFLICT ON CONSTRAINT "UQ_activity_daily" DO UPDATE SET n = EXCLUDED.n, ex = EXCLUDED.ex, ey = EXCLUDED.ey, ew = EXCLUDED.ew, eh = EXCLUDED.eh`,
            [dias],
        );
        await this.ds.query(
            `INSERT INTO activity_hourly (day, "userId", "platformRole", "storeRole", hour, events, seconds)
             SELECT (e.at AT TIME ZONE '${ZONA_HORARIA}')::date, e."userId", e."platformRole", e."storeRole",
                    EXTRACT(HOUR FROM e.at AT TIME ZONE '${ZONA_HORARIA}')::smallint,
                    count(*) FILTER (WHERE e.type <> 'ping')::int,
                    COALESCE(sum(e.value) FILTER (WHERE e.type = 'ping'), 0)::int
               FROM activity_events e
              WHERE e.at >= ${desde}
              GROUP BY 1, 2, 3, 4, 5
             ON CONFLICT ON CONSTRAINT "UQ_activity_hourly" DO UPDATE SET events = EXCLUDED.events, seconds = EXCLUDED.seconds`,
            [dias],
        );
    }

    /** Antes de leer los resúmenes se ponen al día los de hoy y ayer (como mucho una vez por minuto). */
    async refrescarSiHaceFalta(): Promise<void> {
        if (Date.now() - this.ultimoResumen < 60_000) return;
        this.ultimoResumen = Date.now();
        await this.refrescarResumenes(2);
    }

    /** Borra lo que pasó su plazo: el detalle a los 90 días; los resúmenes y las sesiones a los 2 años. */
    async limpiar(): Promise<{ eventos: number }> {
        const hoy = `(now() AT TIME ZONE '${ZONA_HORARIA}')::date`;
        const [, borrados] = await this.ds.query(
            `DELETE FROM activity_events WHERE at < ((date_trunc('day', now() AT TIME ZONE '${ZONA_HORARIA}') - make_interval(days => $1)) AT TIME ZONE '${ZONA_HORARIA}')`,
            [DIAS_DE_DETALLE],
        );
        await this.ds.query(`DELETE FROM activity_daily WHERE day < ${hoy} - $1::int`, [DIAS_DE_RESUMEN]);
        await this.ds.query(`DELETE FROM activity_hourly WHERE day < ${hoy} - $1::int`, [DIAS_DE_RESUMEN]);
        await this.ds.query(`DELETE FROM activity_sessions WHERE "startedAt" < now() - make_interval(days => $1)`, [DIAS_DE_RESUMEN]);
        return { eventos: Number(borrados ?? 0) };
    }

    /**
     * Mantenimiento diario. Primero se recalcula todo el detalle que sigue guardado (así nada se pierde antes de borrarlo) y
     * después se borra lo vencido. Con varias réplicas, un candado en Redis hace que solo una lo haga.
     */
    async mantenimiento(): Promise<void> {
        try {
            const libre = await this.redis.set('activity:mantenimiento', '1', 'EX', 20 * 3600, 'NX');
            if (!libre) return;
            await this.refrescarResumenes(DIAS_DE_DETALLE + 5);
            const r = await this.limpiar();
            this.logger.log(`Mantenimiento de actividad hecho (${r.eventos} eventos vencidos borrados).`);
        } catch (error: any) {
            this.logger.warn(`No se pudo hacer el mantenimiento de la actividad: ${error?.message}`);
        }
    }
}
