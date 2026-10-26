import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';

/**
 * Las colas guardan en Redis el historial de cada trabajo terminado. Sin limpiarlo crece sin fin (cada lectura de
 * Falabella o Mercado Libre, cada actualización de stock y cada publicación deja su registro) hasta llenar el disco de
 * Redis y tumbar el servidor. Esto lo limpia al arrancar y cada pocas horas; además cada trabajo nuevo ya se borra solo
 * (ver defaultJobOptions en AppModule).
 */
export const COLAS = ['marketplace-sync-queue', 'generate-listings-queue', 'category-seed-queue', 'product-edit-queue', 'category-edit-queue'];

export const POLITICA_DE_LIMPIEZA = {
    /** Un trabajo terminado bien se conserva una hora. */
    completadosMs: 60 * 60_000,
    /** Uno fallido se conserva tres días, para poder ver por qué falló. */
    fallidosMs: 3 * 24 * 3600_000,
    /** Cuántos se borran por pasada (Redis se mantiene ágil si se hace por tandas). */
    tanda: 2_000,
    /** Tope de tandas por cola y vuelta, por si hay millones. */
    maxTandas: 500,
};

/** Lo mínimo que se necesita de una cola de BullMQ (así se puede probar sin Redis). */
export interface ColaLimpiable {
    name: string;
    clean(grace: number, limit: number, type: 'completed' | 'failed'): Promise<string[]>;
    trimEvents?(maxLength: number): Promise<number>;
}

/** Borra los trabajos viejos de una cola por tandas. Devuelve cuántos borró de cada tipo. */
export async function limpiarCola(cola: ColaLimpiable, politica = POLITICA_DE_LIMPIEZA): Promise<{ completados: number; fallidos: number }> {
    const borrados = { completados: 0, fallidos: 0 };
    for (const [tipo, gracia, campo] of [['completed', politica.completadosMs, 'completados'], ['failed', politica.fallidosMs, 'fallidos']] as const) {
        for (let i = 0; i < politica.maxTandas; i++) {
            const ids = await cola.clean(gracia, politica.tanda, tipo);
            borrados[campo] += ids.length;
            if (ids.length < politica.tanda) break;
        }
    }
    // El historial de eventos de la cola también se acota.
    try { await cola.trimEvents?.(1_000); } catch { /* no es crítico */ }
    return borrados;
}

@Injectable()
export class QueueMaintenanceService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(QueueMaintenanceService.name);
    private colas: Queue[] = [];
    private temporizador?: NodeJS.Timeout;
    private inicio?: NodeJS.Timeout;
    private corriendo = false;

    onModuleInit() {
        const connection = {
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD || undefined,
        };
        this.colas = COLAS.map((nombre) => new Queue(nombre, { connection }));
        // Sin bloquear el arranque: primero deja que el servidor levante.
        this.inicio = setTimeout(() => void this.limpiar(), 20_000);
        this.temporizador = setInterval(() => void this.limpiar(), 6 * 3600_000);
        this.inicio.unref?.();
        this.temporizador.unref?.();
    }

    async limpiar(): Promise<void> {
        if (this.corriendo) return;
        this.corriendo = true;
        try {
            for (const cola of this.colas) {
                try {
                    const r = await limpiarCola(cola as unknown as ColaLimpiable);
                    if (r.completados || r.fallidos) this.logger.log(`Cola ${cola.name}: ${r.completados} completados y ${r.fallidos} fallidos antiguos borrados.`);
                } catch (error: any) {
                    this.logger.warn(`No se pudo limpiar la cola ${cola.name}: ${error?.message}`);
                }
            }
        } finally {
            this.corriendo = false;
        }
    }

    async onModuleDestroy() {
        if (this.inicio) clearTimeout(this.inicio);
        if (this.temporizador) clearInterval(this.temporizador);
        await Promise.allSettled(this.colas.map((c) => c.close()));
    }
}
