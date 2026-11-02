/**
 * Prueba de carga con canales simulados: pasa N productos por el AiProcessor REAL (el mismo código de la carga masiva)
 * con la IA, Mercado Libre, Falabella, Redis y la base falsos y en memoria. No toca ningún servicio ni producto real.
 *
 * Mide lo que sí se puede medir sin infraestructura: que no se pierda ningún producto, cuántos envíos a Falabella
 * (llamadas) se gastan, el tamaño de cada tanda y la memoria del proceso. NO mide la velocidad real de la IA, de Redis
 * ni de Postgres: los tiempos son simulados.
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/simular-carga.ts [total] [concurrencia] [tanda] [fallosIA%]
 *   (por defecto: 1000 productos, 6 a la vez, sin tandas, 3 % de fallos de la IA)
 */
import { AiProcessor } from '../bulk-upload/ai.processor';
import { BatchNotificationService } from '../bulk-upload/batch-notification.service';
import { BulkBatchService } from '../bulk-upload/bulk-batch.service';

const [total = 1000, concurrencia = 6, tanda = 0, fallosIA = 3] = process.argv.slice(2).map(Number);
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const aleatorio = (min: number, max: number) => min + Math.random() * (max - min);

/** Redis mínimo en memoria: lo que usan el seguimiento del lote y la lista de pendientes de Falabella. */
function redisFalso() {
    const hashes = new Map<string, Record<string, string>>();
    const sets = new Map<string, Set<string>>();
    const h = (k: string) => hashes.get(k) ?? hashes.set(k, {}).get(k)!;
    const s = (k: string) => sets.get(k) ?? sets.set(k, new Set()).get(k)!;
    const op = {
        hsetnx: (k: string, f: string, v: string) => { const x = h(k); if (!(f in x)) x[f] = v; return 1; },
        hincrby: (k: string, f: string, n: number) => (h(k)[f] = String(Number(h(k)[f] ?? 0) + n)),
        hmget: (k: string, ...fs: string[]) => fs.map((f) => h(k)[f] ?? null),
        hgetall: (k: string) => ({ ...h(k) }),
        expire: () => 1,
        sadd: (k: string, v: string) => (s(k).add(v), 1),
        scard: (k: string) => s(k).size,
        smembers: (k: string) => [...s(k)],
        del: (k: string) => (sets.delete(k), hashes.delete(k), 1),
        spop: (k: string, n: number) => { const x = s(k); const out = [...x].slice(0, n); out.forEach((i) => x.delete(i)); return out; },
    };
    const api: any = {};
    for (const [nombre, fn] of Object.entries(op)) api[nombre] = async (...a: any[]) => (fn as any)(...a);
    api.multi = () => {
        const cola: (() => unknown)[] = [];
        const tx: any = { exec: async () => cola.map((c) => [null, c()]) };
        for (const [nombre, fn] of Object.entries(op)) tx[nombre] = (...a: any[]) => { cola.push(() => (fn as any)(...a)); return tx; };
        return tx;
    };
    return { api, sets };
}

/** Base en memoria para el registro del lote (mismas consultas que usa BulkBatchService). */
function baseFalsa() {
    const lotes: any[] = [];
    const items: any[] = [];
    const coincide = (i: any, w: any) => Object.entries(w).every(([k, v]: [string, any]) => (v?._type === 'in' ? v._value.includes(i[k]) : i[k] === v));
    const repoLotes: any = {
        create: (d: any) => ({ ...d }),
        save: async (l: any) => (lotes.push(l), l),
        update: async (w: any, c: any) => { Object.assign(lotes.find((l) => l.id === w.id) ?? {}, c); },
        findOne: async ({ where }: any) => lotes.find((l) => l.id === where.id) ?? null,
    };
    const repoItems: any = {
        create: (d: any) => ({ ...d }),
        save: async (l: any[]) => (items.push(...l), l),
        update: async (w: any, c: any) => { items.filter((i) => coincide(i, w)).forEach((i) => Object.assign(i, c)); },
        find: async ({ where }: any) => items.filter((i) => coincide(i, where)),
    };
    return { service: new BulkBatchService(repoLotes, repoItems), items };
}

async function main() {
    process.env.FALABELLA_BATCH_SIZE = tanda ? String(tanda) : '';
    const { api: redis, sets } = redisFalso();
    const { service: registro, items } = baseFalsa();
    const correos: any[] = [];
    const lote = new BatchNotificationService(redis, { sendJobCompleted: async (...a: any[]) => correos.push(a) } as any);

    const productos = new Map<string, any>();
    let siguienteId = 1;
    let enMarcha = 0, picoEnMarcha = 0, picoEnRedis = 0;
    const tandas: number[] = [];
    let llamadasML = 0;

    const procesador: any = new AiProcessor(
        { generateProductContent: async () => {
            enMarcha++; picoEnMarcha = Math.max(picoEnMarcha, enMarcha);
            await espera(aleatorio(20, 60));
            enMarcha--;
            if (Math.random() * 100 < fallosIA) throw new Error('DeepSeek no respondió (simulado)');
            return { vision: {} };
        } } as any,
        {
            findBySku: async (_s: any, sku: string) => [...productos.values()].find((p) => p.sku === sku) ?? null,
            create: async (d: any) => { const p = { ...d, id: `p${siguienteId++}` }; productos.set(p.id, p); return p; },
            applyAiContent: () => undefined,
            save: async (p: any) => p,
        } as any,
        {
            getConnections: async () => [{ id: 'ml1', status: 'active', marketplace: 'mercadolibre' }, { id: 'fa1', status: 'active', marketplace: 'falabella' }],
            enqueuePublish: async () => { llamadasML++; await espera(1); },
            publishBatchToFalabella: async (_s: any, _c: string, ids: string[]) => { await espera(30); tandas.push(ids.length); return { enviados: ids.length, rechazados: [] }; },
            avisarProductosPorRevisar: async () => undefined,
        } as any,
        { preparar: async (_s: any, id: string) => { await espera(aleatorio(5, 15)); return { category: '1', sku: id }; } } as any,
        lote,
        registro,
    );

    const trabajos = Array.from({ length: total }, (_, i) => ({
        sku: `SKU-${i + 1}`, productName: `Producto ${i + 1}`, description: 'x', price: 10, stock: 5, targetMarketplaces: ['mercadolibre', 'falabella'],
        publishTo: ['mercadolibre', 'falabella'], cuentas: {}, storeId: 's1', userId: 'u1', userEmail: 'a@b.c', imageUrls: ['http://x/1.jpg'],
        batchId: 'lote-1', batchTotal: total,
    }));
    await registro.crear('lote-1', 'u1', 's1', trabajos.map((t) => ({ sku: t.sku, payload: t })));
    await lote.iniciar('lote-1', total, 'u1');

    // Una cola con los mismos 3 intentos que la real: un fallo pasajero se reintenta antes de darlo por fallido.
    const correr = async (data: any) => {
        for (let intento = 0; intento < 3; intento++) {
            try { await procesador.process({ id: data.sku, name: 'process-product', data, attemptsMade: intento, opts: { attempts: 3 } }); return; } catch { /* reintento */ }
        }
    };
    const silencio = console.log; console.log = () => undefined;
    const aviso = console.warn; console.warn = () => undefined;
    const error = console.error; console.error = () => undefined;
    const inicio = Date.now();
    const cola = [...trabajos];
    const memoriaAntes = process.memoryUsage().heapUsed;
    let picoMemoria = memoriaAntes;
    await Promise.all(Array.from({ length: concurrencia }, async () => {
        while (cola.length) {
            await correr(cola.shift()!);
            picoMemoria = Math.max(picoMemoria, process.memoryUsage().heapUsed);
            picoEnRedis = Math.max(picoEnRedis, ...[...sets.values()].map((x) => x.size), 0);
        }
    }));
    console.log = silencio; console.warn = aviso; console.error = error;

    const estados = (campo: string) => items.reduce((m: Record<string, number>, i) => ((m[i[campo] ?? 'ninguno'] = (m[i[campo] ?? 'ninguno'] ?? 0) + 1), m), {});
    const resumen = await registro.resumen('lote-1', 'u1');
    const llamadasFalabella = tandas.length * 2; // cada tanda: una de crear productos + una de imágenes
    console.log(`\nPrueba de carga simulada: ${total} productos, ${concurrencia} a la vez, ${tanda ? `tandas de ${tanda}` : 'Falabella al final del lote'}, ${fallosIA} % de fallos de la IA`);
    console.log(`  Duración simulada:           ${((Date.now() - inicio) / 1000).toFixed(1)} s (no es la velocidad real)`);
    console.log(`  Productos creados / fallidos: ${resumen?.processed} / ${resumen?.failed}  (lote cerrado: ${resumen?.terminado}, correos de fin: ${correos.length})`);
    console.log(`  Estado en la base (producto): ${JSON.stringify(estados('status'))}`);
    console.log(`  Estado en la base (Falabella): ${JSON.stringify(estados('falabellaStatus'))}`);
    console.log(`  Publicaciones a Mercado Libre: ${llamadasML}`);
    console.log(`  Envíos a Falabella: ${tandas.length} tandas ${JSON.stringify(tandas)} → ~${llamadasFalabella} llamadas (50 gratis, luego 1 cada 2 min)`);
    console.log(`  Pico de productos a la vez en la IA: ${picoEnMarcha}; pico de la lista de pendientes en Redis: ${picoEnRedis}`);
    console.log(`  Memoria del proceso: ${(memoriaAntes / 1048576).toFixed(0)} MB → pico ${(picoMemoria / 1048576).toFixed(0)} MB (solo la simulación)`);

    const sinEnviar = items.filter((i) => i.status === 'listo' && i.falabellaStatus !== 'enviado').length;
    const enviados = tandas.reduce((a, b) => a + b, 0);
    console.log(sinEnviar === 0 && enviados === resumen?.processed
        ? `\n✓ Ningún producto se perdió: los ${enviados} creados se enviaron a Falabella.`
        : `\n✗ HAY PRODUCTOS PERDIDOS: ${sinEnviar} sin enviar a Falabella; enviados ${enviados} de ${resumen?.processed} creados.`);
    process.exit(sinEnviar === 0 && enviados === resumen?.processed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
