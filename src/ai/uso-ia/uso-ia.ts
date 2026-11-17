import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Registro del consumo real de IA (tokens y costo) por usuario.
 *
 * No toca cada llamada: los clientes de OpenAI/DeepSeek se envuelven una sola vez (`medirUso`) y el usuario sale del contexto
 * (`conUsoIa`) que abren los puntos de entrada (generar producto, preparar Falabella, llenar atributos…). Una llamada sin
 * contexto se anota igual, con el usuario vacío ("sin asignar"). Registrar nunca rompe ni retrasa una llamada de IA.
 */

export interface ContextoDeUso { userId?: string | null; operacion?: string; ejecucion?: string }

export interface FilaDeUso {
    userId: string | null;
    operation: string;
    /** Identifica una ejecución completa (p. ej. un producto generado), para contar productos y no llamadas. */
    runId: string | null;
    provider: string;
    model: string;
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
    costUsd: number;
    priceKnown: boolean;
}

/** Precio en USD por millón de tokens. `entrada` es lo que no estaba en caché; `cache` lo que sí; `salida` lo generado. */
export interface Precio { entrada: number; cache: number; salida: number }

/**
 * Tarifas públicas (revisar cuando cambien). Se pueden sobrescribir sin tocar el código con la variable AI_PRECIOS_JSON, por ejemplo
 * {"deepseek-chat":{"entrada":0.28,"cache":0.028,"salida":0.42}}.
 */
export const PRECIOS_POR_DEFECTO: Record<string, Precio> = {
    'gpt-4o-mini': { entrada: 0.15, cache: 0.075, salida: 0.6 },
    'gpt-4o': { entrada: 2.5, cache: 1.25, salida: 10 },
    'text-embedding-3-small': { entrada: 0.02, cache: 0.02, salida: 0 },
    'deepseek-chat': { entrada: 0.14, cache: 0.0028, salida: 0.28 },
    'deepseek-flash': { entrada: 0.14, cache: 0.0028, salida: 0.28 },
    'deepseek-v4-flash': { entrada: 0.14, cache: 0.0028, salida: 0.28 },
    'deepseek-v4-pro': { entrada: 0.435, cache: 0.003625, salida: 0.87 },
};

export function precioDe(modelo: string, extra: string | undefined = process.env.AI_PRECIOS_JSON): Precio | null {
    let tabla = PRECIOS_POR_DEFECTO;
    if (extra) {
        try { tabla = { ...PRECIOS_POR_DEFECTO, ...JSON.parse(extra) }; } catch { /* variable mal escrita: se usan las de siempre */ }
    }
    const clave = String(modelo ?? '').toLowerCase();
    if (tabla[clave]) return tabla[clave];
    // Versiones con fecha (gpt-4o-mini-2024-07-18): se toma la de nombre más largo que sea prefijo.
    const prefijo = Object.keys(tabla).filter((k) => clave.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return prefijo ? tabla[prefijo] : null;
}

/** Lee los tokens de la respuesta (formato OpenAI y DeepSeek) y calcula el costo. Sin precio conocido el costo es 0 y se marca. */
export function usoDeRespuesta(modelo: string, usage: any, precios?: string): Pick<FilaDeUso, 'promptTokens' | 'cachedTokens' | 'completionTokens' | 'costUsd' | 'priceKnown'> {
    const prompt = Number(usage?.prompt_tokens ?? usage?.total_tokens ?? 0) || 0;
    const completion = Number(usage?.completion_tokens ?? 0) || 0;
    // DeepSeek informa aciertos de caché aparte; OpenAI dentro de prompt_tokens_details.
    const cached = Number(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0) || 0;
    const cachedValidos = Math.min(Math.max(cached, 0), prompt);
    const precio = precioDe(modelo, precios);
    const costUsd = precio
        ? ((prompt - cachedValidos) * precio.entrada + cachedValidos * precio.cache + completion * precio.salida) / 1_000_000
        : 0;
    return { promptTokens: prompt, cachedTokens: cachedValidos, completionTokens: completion, costUsd, priceKnown: !!precio };
}

const almacen = new AsyncLocalStorage<ContextoDeUso>();

/** Abre un contexto: todo lo que corra dentro (incluidas las esperas) se anota a ese usuario. Hereda lo que el exterior ya definió. */
export function conUsoIa<T>(contexto: ContextoDeUso, fn: () => T): T {
    const actual = almacen.getStore();
    return almacen.run({
        userId: contexto.userId ?? actual?.userId ?? null,
        operacion: contexto.operacion ?? actual?.operacion,
        // Cada operación nueva empieza una ejecución nueva; sin operación se sigue en la de afuera.
        ejecucion: contexto.operacion ? randomUUID() : actual?.ejecucion,
    }, fn);
}

export const contextoDeUso = (): ContextoDeUso | undefined => almacen.getStore();

type Sumidero = (fila: FilaDeUso) => void;
let sumidero: Sumidero | null = null;
export function conectarRegistroDeUso(s: Sumidero | null) { sumidero = s; }

function anotar(proveedor: string, modelo: string, usage: any) {
    if (!sumidero || !usage) return;
    try {
        const ctx = almacen.getStore();
        sumidero({
            userId: ctx?.userId ?? null,
            operation: ctx?.operacion ?? 'sin-operacion',
            runId: ctx?.ejecucion ?? null,
            provider: proveedor,
            model: String(modelo ?? 'desconocido'),
            ...usoDeRespuesta(modelo, usage),
        });
    } catch { /* medir nunca rompe la llamada */ }
}

const MEDIDO = Symbol.for('synkro.medirUso');

/** Envuelve `chat.completions.create` y `embeddings.create` del cliente para anotar los tokens de cada respuesta. Idempotente. */
export function medirUso<T>(cliente: T, proveedor: string): T {
    const c: any = cliente;
    if (!c || c[MEDIDO]) return cliente;
    c[MEDIDO] = true;
    const envolver = (objeto: any) => {
        if (!objeto || typeof objeto.create !== 'function') return;
        const original = objeto.create.bind(objeto);
        objeto.create = (...args: any[]) => {
            const modelo = args[0]?.model;
            const promesa = original(...args);
            // `create` devuelve una APIPromise (con .asResponse(), etc.): se le agrega el registro sin cambiar lo que devuelve.
            if (promesa && typeof promesa.then === 'function') promesa.then((r: any) => anotar(proveedor, modelo, r?.usage), () => undefined);
            return promesa;
        };
    };
    envolver(c.chat?.completions);
    envolver(c.embeddings);
    return cliente;
}
