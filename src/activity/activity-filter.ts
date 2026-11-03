import { BadRequestException } from '@nestjs/common';
import { ROLES_DE_PLATAFORMA, ROLES_DE_TIENDA } from './activity.constants';
import { esUuid } from './activity-validation';

/**
 * Los filtros de todas las consultas de Superadmin › Actividad: rango de fechas (día de Lima), una persona o todas, y roles
 * de la plataforma y de la tienda (se pueden marcar varios en cada uno).
 */
export interface FiltroDeActividad {
    desde: string;
    hasta: string;
    userId: string | null;
    rolesPlataforma: string[];
    rolesTienda: string[];
    /** Con «todos», promedia por usuario (cada persona pesa igual) en lugar de sumar. */
    promedio: boolean;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const DIA_MS = 86_400_000;
const MAX_DIAS = 730;

function csv(valor: unknown, permitidos: readonly string[], nombre: string): string[] {
    const lista = String(valor ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    const raros = lista.filter((v) => !permitidos.includes(v));
    if (raros.length) throw new BadRequestException(`${nombre} no válido: ${raros.join(', ')}. Usa: ${permitidos.join(', ')}.`);
    return [...new Set(lista)];
}

/** Lee y valida los filtros de la consulta. `hoy` es el día de hoy en Lima (AAAA-MM-DD). */
export function leerFiltro(q: Record<string, any>, hoy: string): FiltroDeActividad {
    const hasta = q.to ?? hoy;
    const desde = q.from ?? new Date(new Date(`${hasta}T12:00:00Z`).getTime() - 29 * DIA_MS).toISOString().slice(0, 10);
    if (!FECHA.test(desde) || !FECHA.test(hasta)) throw new BadRequestException('Las fechas deben tener el formato AAAA-MM-DD.');
    if (desde > hasta) throw new BadRequestException('La fecha de inicio no puede ser posterior a la final.');
    if ((new Date(`${hasta}T12:00:00Z`).getTime() - new Date(`${desde}T12:00:00Z`).getTime()) / DIA_MS > MAX_DIAS) {
        throw new BadRequestException(`El rango no puede pasar de ${MAX_DIAS} días.`);
    }
    if (q.userId !== undefined && q.userId !== '' && !esUuid(q.userId)) throw new BadRequestException('El usuario no es válido.');
    const userId = q.userId ? String(q.userId).toLowerCase() : null;
    return {
        desde,
        hasta,
        userId,
        rolesPlataforma: csv(q.platformRoles, ROLES_DE_PLATAFORMA, 'Rol de plataforma'),
        rolesTienda: csv(q.storeRoles, ROLES_DE_TIENDA, 'Rol de tienda'),
        // Con una sola persona no hay nada que promediar; con varias, por defecto se promedia.
        promedio: !userId && q.mode !== 'total',
    };
}

/** Arma las condiciones SQL de un filtro sobre una tabla con `day`, `userId`, `platformRole` y `storeRole`. */
export function condicionesSql(f: FiltroDeActividad, alias: string, params: unknown[], columnaDeDia = `${alias}.day`): string {
    const poner = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const c = [`${columnaDeDia} BETWEEN ${poner(f.desde)}::date AND ${poner(f.hasta)}::date`];
    if (f.userId) c.push(`${alias}."userId" = ${poner(f.userId)}::uuid`);
    if (f.rolesPlataforma.length) c.push(`${alias}."platformRole" = ANY(${poner(f.rolesPlataforma)}::text[])`);
    if (f.rolesTienda.length) c.push(`${alias}."storeRole" = ANY(${poner(f.rolesTienda)}::text[])`);
    return c.join(' AND ');
}
