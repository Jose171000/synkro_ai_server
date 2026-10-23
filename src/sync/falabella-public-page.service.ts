import { Injectable, Logger } from '@nestjs/common';
import { LecturaDePagina, leerPaginaPublica } from './falabella/pagina-publica';

const TIEMPO_MAXIMO_MS = 15_000;
const VIGENCIA_MS = 6 * 3600_000;
/** Pausa entre dos lecturas: pocas peticiones y sin ráfagas. */
const PAUSA_MS = 800;
const SOLO_FALABELLA = /^https:\/\/(www\.)?falabella\.com\.[a-z]{2}\//i;

/**
 * Lee la página pública de una ficha de Falabella (HTML) para saber en qué eje se diferencian sus variantes.
 * Se identifica con claridad, hace pocas peticiones, recuerda lo leído unas horas y, si la página no responde, la bloquea
 * o cambió, devuelve `ok: false`: nunca inventa datos.
 */
@Injectable()
export class FalabellaPublicPageService {
    private readonly logger = new Logger(FalabellaPublicPageService.name);
    private readonly cache = new Map<string, { at: number; lectura: LecturaDePagina }>();
    private ultimaPeticion = 0;

    async leer(url: string): Promise<LecturaDePagina & { bloqueada?: boolean }> {
        if (!SOLO_FALABELLA.test(url)) return { ok: false, motivo: 'la dirección no es de Falabella', variantes: [] };
        const guardada = this.cache.get(url);
        if (guardada && Date.now() - guardada.at < VIGENCIA_MS) return guardada.lectura;

        const espera = this.ultimaPeticion + PAUSA_MS - Date.now();
        if (espera > 0) await new Promise((r) => setTimeout(r, espera));
        this.ultimaPeticion = Date.now();

        try {
            const respuesta = await fetch(url, {
                headers: { 'User-Agent': 'SynkroAI/1.0 (+https://synkroai.com) lectura de variantes de nuestras propias publicaciones', 'Accept': 'text/html', 'Accept-Language': 'es-PE,es;q=0.9' },
                signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
            });
            if (respuesta.status === 403 || respuesta.status === 429 || respuesta.status === 503) {
                return { ok: false, bloqueada: true, motivo: `Falabella no dejó leer la página (código ${respuesta.status})`, variantes: [] };
            }
            if (!respuesta.ok) return { ok: false, motivo: `la página respondió ${respuesta.status}`, variantes: [] };
            const lectura = leerPaginaPublica(await respuesta.text());
            // Solo se recuerdan las lecturas buenas: un fallo puntual no debe quedar fijado.
            if (lectura.ok) this.cache.set(url, { at: Date.now(), lectura });
            return lectura;
        } catch (error: any) {
            this.logger.warn(`No se pudo leer ${url}: ${error?.message}`);
            return { ok: false, motivo: 'no se pudo abrir la página', variantes: [] };
        }
    }
}
