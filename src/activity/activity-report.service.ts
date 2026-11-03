import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ActivityQueriesService } from './activity-queries.service';
import { FiltroDeActividad } from './activity-filter';
import { limpiarEtiqueta } from './activity-validation';
import { NOMBRE_ROL_PLATAFORMA, NOMBRE_ROL_TIENDA } from './activity-nombres';

/** Bloques que puede llevar un informe descargable. Por defecto lleva todos. */
export const BLOQUES_DE_INFORME = ['resumen', 'secciones', 'funciones', 'horarios', 'personas', 'clics', 'linea'] as const;
export type BloqueDeInforme = (typeof BLOQUES_DE_INFORME)[number];

const MAX_PANTALLAS = 40;

export interface OpcionesDeInforme {
    bloques: BloqueDeInforme[];
    /** Pantallas elegidas para los mapas de clics; vacío = todas las que tengan clics. */
    pantallas: string[];
    /** Los bloques y pantallas son los de por defecto (todo). */
    completo: boolean;
}

/** Lee `include` y `screens` de la consulta. Lo que no se pide, se incluye (informe completo). */
export function leerOpcionesDeInforme(q: Record<string, any>): OpcionesDeInforme {
    const pedidos = String(q.include ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    const raros = pedidos.filter((v) => !(BLOQUES_DE_INFORME as readonly string[]).includes(v));
    if (raros.length) throw new BadRequestException(`Bloque no válido: ${raros.join(', ')}. Usa: ${BLOQUES_DE_INFORME.join(', ')}.`);
    const pantallas = [...new Set(
        String(q.screens ?? '').split(',').map((v) => limpiarEtiqueta(v.trim(), 60)).filter((v): v is string => !!v),
    )].slice(0, MAX_PANTALLAS);
    const bloques = (pedidos.length ? pedidos : [...BLOQUES_DE_INFORME]) as BloqueDeInforme[];
    return { bloques: [...new Set(bloques)], pantallas, completo: !pedidos.length && !pantallas.length };
}

type Resumen = Awaited<ReturnType<ActivityQueriesService['resumen']>>;
type Ranking = Awaited<ReturnType<ActivityQueriesService['secciones']>>;
type Horas = Awaited<ReturnType<ActivityQueriesService['horas']>>;
type Personas = Awaited<ReturnType<ActivityQueriesService['personas']>>;
type Clics = Awaited<ReturnType<ActivityQueriesService['clics']>>;
type Linea = Awaited<ReturnType<ActivityQueriesService['linea']>>;
type Plano = Awaited<ReturnType<ActivityQueriesService['plano']>>;

export interface Informe {
    generadoEn: Date;
    opciones: OpcionesDeInforme;
    periodo: { desde: string; hasta: string };
    persona: string | null;
    promedio: boolean;
    rolesPlataforma: string[];
    rolesTienda: string[];
    resumen: Resumen | null;
    secciones: Ranking | null;
    funciones: Ranking | null;
    horas: Horas | null;
    personas: Personas | null;
    pantallas: { pantalla: string; clics: number; usuarios: number; vistas: number; elementos: Clics; plano: Plano }[] | null;
    /** Cuántas pantallas con clics quedaron fuera por el tope de cada formato. */
    pantallasOmitidas: number;
    linea: Linea | null;
}

/**
 * Junta los datos de un informe de actividad con los mismos filtros de la pantalla. Los formatos (Excel y PDF) solo
 * dibujan lo que esto devuelve: no consultan nada por su cuenta.
 */
@Injectable()
export class ActivityReportService {
    constructor(
        private readonly consultas: ActivityQueriesService,
        private readonly ds: DataSource,
    ) { }

    async armar(f: FiltroDeActividad, opciones: OpcionesDeInforme, maxPantallas: number): Promise<Informe> {
        const quiere = (b: BloqueDeInforme) => opciones.bloques.includes(b);

        let persona: string | null = null;
        if (f.userId) {
            const [u] = await this.ds.query(`SELECT name, "lastName" FROM users WHERE id = $1::uuid`, [f.userId]);
            persona = u ? `${u.name} ${u.lastName}`.trim() : 'Usuario eliminado';
        }

        const [resumen, secciones, funciones, horas, personas, linea, todasLasPantallas] = await Promise.all([
            quiere('resumen') ? this.consultas.resumen(f) : null,
            quiere('secciones') ? this.consultas.secciones(f) : null,
            quiere('funciones') ? this.consultas.funciones(f) : null,
            quiere('horarios') ? this.consultas.horas(f) : null,
            quiere('personas') && !f.userId ? this.consultas.personas(f) : null,
            quiere('linea') && f.userId ? this.consultas.linea(f.userId, f) : null,
            quiere('clics') ? this.consultas.pantallas(f) : null,
        ]);

        let pantallas: Informe['pantallas'] = null;
        let omitidas = 0;
        if (todasLasPantallas) {
            const elegidas = opciones.pantallas.length
                ? todasLasPantallas.filter((p) => opciones.pantallas.includes(p.pantalla))
                : todasLasPantallas;
            const incluidas = elegidas.slice(0, Math.min(maxPantallas, MAX_PANTALLAS));
            omitidas = elegidas.length - incluidas.length;
            pantallas = await Promise.all(incluidas.map(async (p) => ({ ...p, elementos: await this.consultas.clics(f, p.pantalla), plano: await this.consultas.plano(p.pantalla) })));
        }

        return {
            generadoEn: new Date(),
            opciones,
            periodo: { desde: f.desde, hasta: f.hasta },
            persona,
            promedio: f.promedio,
            rolesPlataforma: f.rolesPlataforma.map((r) => NOMBRE_ROL_PLATAFORMA[r] ?? r),
            rolesTienda: f.rolesTienda.map((r) => NOMBRE_ROL_TIENDA[r] ?? r),
            resumen, secciones, funciones, horas,
            personas: personas ? personas.slice(0, 500) : null,
            pantallas,
            pantallasOmitidas: omitidas,
            linea,
        };
    }
}
