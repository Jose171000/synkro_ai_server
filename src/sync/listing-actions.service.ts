import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ListingLink } from './entities/listing-link.entity';
import { MeliApiService } from './meli/meli-api.service';
import { FalabellaApiService } from './falabella/falabella-api.service';
import { SyncScope, SyncService } from './sync.service';
import { detectarDuplicados, elegirDuplicadasAfectables } from './meli/duplicados-meli';
import { filasDeItemMeli } from './meli/meli-listings';

export type AccionDeCanal = 'pause' | 'resume' | 'remove';

export interface ResultadoDeCanal {
    linkId: string;
    marketplace: string;
    connectionId: string | null;
    account: string | null;
    ok: boolean;
    /** Lo que se hizo, o por qué no se pudo, en lenguaje claro. */
    message: string;
}

const NOMBRE_DE_CANAL: Record<string, string> = { mercadolibre: 'Mercado Libre', falabella: 'Falabella', shopify: 'Shopify', woocommerce: 'WooCommerce', yavendio: 'Yavendio' };

/** Estados en los que cada acción tiene sentido. */
const ESTADOS_QUE_ADMITEN: Record<AccionDeCanal, ListingLink['syncStatus'][]> = {
    pause: ['published'],
    resume: ['paused'],
    remove: ['published', 'paused', 'error'],
};

/**
 * Pausar, reanudar o quitar un producto de uno o de todos sus canales.
 *
 * Mercado Libre: pausa y reactivación con el estado de la publicación; quitar la cierra (definitivo).
 * Falabella: pausar es dejar el stock en 0 (la ficha sigue ahí, sin poder venderse); reanudar vuelve a enviar el stock
 * real; quitar da de baja la ficha (ProductRemove). Los demás canales aún no se pueden controlar desde aquí y se avisa.
 */
@Injectable()
export class ListingActionsService {
    private readonly logger = new Logger(ListingActionsService.name);

    constructor(
        @InjectRepository(ListingLink) private readonly listingLinkRepository: Repository<ListingLink>,
        private readonly sync: SyncService,
        private readonly meliApi: MeliApiService,
        private readonly falabellaApi: FalabellaApiService,
    ) { }

    /**
     * Aplica la acción a las publicaciones del producto en esta tienda. Sin `linkIds` actúa sobre todas las que admiten
     * la acción (botón general); con `linkIds`, solo sobre esas (botón de un canal).
     */
    async ejecutar(scope: SyncScope, productId: string, accion: AccionDeCanal, linkIds?: string[]): Promise<{ results: ResultadoDeCanal[]; message: string }> {
        await this.sync.findScopedProduct(scope, productId);

        const enlaces = await this.listingLinkRepository.find({
            where: {
                product: { id: productId },
                connection: { store: { id: scope.storeId } },
                ...(linkIds?.length ? { id: In(linkIds) } : {}),
            },
            relations: { product: true, connection: true },
        });

        const resultados: ResultadoDeCanal[] = [];
        let aplicables = 0;
        for (const enlace of enlaces) {
            if (!ESTADOS_QUE_ADMITEN[accion].includes(this.estadoEfectivo(enlace))) continue;
            aplicables++;
            resultados.push(await this.aplicar(enlace, accion));
        }
        if (!aplicables) {
            throw new BadRequestException(
                accion === 'resume' ? 'Ninguna publicación de este producto está pausada.'
                    : accion === 'pause' ? 'Ninguna publicación activa de este producto se puede pausar.'
                        : 'Este producto no tiene publicaciones que quitar.',
            );
        }

        const bien = resultados.filter(r => r.ok).length;
        const verbo = accion === 'pause' ? 'Pausado' : accion === 'resume' ? 'Reanudado' : 'Quitado';
        return {
            results: resultados,
            message: bien === resultados.length
                ? `${verbo} en ${resultados.map(r => this.etiqueta(r)).join(', ')}.`
                : `${verbo} en ${bien} de ${resultados.length} canales. Revisa el detalle: ${resultados.filter(r => !r.ok).map(r => `${this.etiqueta(r)}: ${r.message}`).join(' — ')}`,
        };
    }

    /**
     * Pausa o cierra publicaciones REPETIDAS de Mercado Libre (mismo SKU en la misma cuenta). Los duplicados se vuelven a
     * detectar aquí con los datos actuales: lo que mande el navegador solo indica cuáles; nunca se toca la principal de un
     * SKU ni una publicación con variaciones que no sean repetidas. Cerrar es definitivo en Mercado Libre.
     */
    async duplicadasMeli(
        scope: SyncScope,
        connectionId: string | undefined,
        accion: 'pause' | 'close',
        externalIds: string[],
    ): Promise<{ results: { externalId: string; ok: boolean; message: string }[]; message: string }> {
        const conexion = await this.sync.resolveConnection(scope.storeId, 'mercadolibre', connectionId);
        const { ids } = await this.meliApi.listSellerItemIds(conexion.accessToken, conexion.externalUserId);
        const { items } = await this.meliApi.getItems(conexion.accessToken, ids);
        const filas = (items as any[]).flatMap((i) => filasDeItemMeli(i).rows);
        const { secundarias } = detectarDuplicados(filas);
        const { aplicables, rechazadas } = elegirDuplicadasAfectables(filas, secundarias, externalIds);

        const results: { externalId: string; ok: boolean; message: string }[] = rechazadas.map((r) => ({ externalId: r.externalId, ok: false, message: r.motivo }));
        for (const externalId of aplicables) {
            try {
                await this.meliApi.setItemStatus(conexion.accessToken, externalId, accion === 'pause' ? 'paused' : 'closed');
                // Si por alguna razón estaba enlazada a un producto de Synkro, el enlace queda marcado igual.
                const enlaces = await this.listingLinkRepository.find({ where: { externalId, connection: { id: conexion.id } } });
                for (const e of enlaces) { this.marcar(e, accion === 'pause' ? 'pause' : 'remove'); await this.listingLinkRepository.save(e); }
                results.push({ externalId, ok: true, message: accion === 'pause' ? 'Pausada' : 'Cerrada' });
            } catch (error: any) {
                const detalle = error?.response?.data?.message ?? error?.message ?? 'error desconocido';
                this.logger.warn(`No se pudo ${accion} la duplicada ${externalId}: ${detalle}`);
                results.push({ externalId, ok: false, message: String(detalle).slice(0, 300) });
            }
        }
        const bien = results.filter((r) => r.ok).length;
        const verbo = accion === 'pause' ? 'pausadas' : 'cerradas';
        return { results, message: `${bien} de ${results.length} publicaciones repetidas ${verbo}.` };
    }

    /**
     * Qué hay de verdad en cada canal para estos SKU de la tienda: lee Mercado Libre y Falabella en vivo (no cambia nada).
     * Sirve para comprobar que algo que se quitó ya no está a la venta, en vez de fiarse solo de la respuesta de la orden.
     */
    async verificarEnCanales(scope: SyncScope, skus: string[]): Promise<{
        sku: string;
        enSynkro: string[];
        mercadolibre: { id: string; estado: string; subestado: string | null; cuenta: string }[];
        falabella: { cuenta: string; existe: boolean; estado: string | null; calidad: string | null }[];
    }[]> {
        const lista = [...new Set(skus.map((s) => String(s).trim()).filter(Boolean))];
        const enlaces = await this.listingLinkRepository.find({
            where: { product: { sku: In(lista) }, connection: { store: { id: scope.storeId } } },
            relations: { product: true, connection: true },
        });

        const salida = new Map(lista.map((sku) => [sku, { sku, enSynkro: [] as string[], mercadolibre: [] as any[], falabella: [] as any[] }]));
        for (const e of enlaces) salida.get(e.product.sku)?.enSynkro.push(`${e.marketplace}: ${e.syncStatus}${e.externalId ? ` (${e.externalId})` : ''}`);

        // Mercado Libre: el estado real de cada publicación que Synkro conoce de estos productos.
        const porCuentaMl = new Map<string, ListingLink[]>();
        for (const e of enlaces.filter((x) => x.marketplace === 'mercadolibre' && x.externalId && x.connection)) {
            porCuentaMl.set(e.connection!.id, [...(porCuentaMl.get(e.connection!.id) ?? []), e]);
        }
        for (const [connectionId, ls] of porCuentaMl) {
            const conexion = await this.sync.getValidConnectionById(connectionId);
            const ids = [...new Set(ls.map((l) => l.externalId))];
            const { items, notFound } = await this.meliApi.getItems(conexion.accessToken, ids);
            const cuenta = conexion.label || conexion.externalNickname || conexion.externalUserId;
            for (const l of ls) {
                const item: any = (items as any[]).find((i) => String(i?.id) === String(l.externalId));
                salida.get(l.product.sku)?.mercadolibre.push({
                    id: l.externalId,
                    estado: item ? String(item.status) : notFound.includes(l.externalId) ? 'no existe' : 'sin respuesta',
                    subestado: item ? (Array.isArray(item.sub_status) ? item.sub_status.join(',') : item.sub_status ?? null) : null,
                    cuenta,
                });
            }
        }

        // Falabella: si la ficha sigue existiendo para ese SKU y en qué estado.
        const porCuentaFa = new Map<string, Set<string>>();
        for (const e of enlaces.filter((x) => x.marketplace === 'falabella' && x.connection)) {
            const s = porCuentaFa.get(e.connection!.id) ?? new Set<string>();
            s.add(e.product.sku);
            porCuentaFa.set(e.connection!.id, s);
        }
        for (const [connectionId, setSkus] of porCuentaFa) {
            const conexion = await this.sync.getValidConnectionById(connectionId);
            const credenciales = this.sync.credentialsOf(conexion);
            const encontrados = await this.falabellaApi.getProductsBySku(credenciales, [...setSkus]);
            const cuenta = conexion.label || conexion.externalNickname || conexion.externalUserId;
            for (const sku of setSkus) {
                const p: any = encontrados.find((x: any) => String(x?.SellerSku).trim() === sku);
                salida.get(sku)?.falabella.push({ cuenta, existe: !!p, estado: p ? String(p.Status ?? '') || null : null, calidad: p ? String(p.QCStatus ?? '') || null : null });
            }
        }
        return [...salida.values()];
    }

    private estadoEfectivo(enlace: ListingLink): ListingLink['syncStatus'] {
        // Una ficha de Falabella pausada con stock 0 puede figurar «publicada» para el canal: manda lo que decidió el usuario.
        return enlace.pausedByUser && enlace.syncStatus === 'published' ? 'paused' : enlace.syncStatus;
    }

    private etiqueta(r: ResultadoDeCanal): string {
        const canal = NOMBRE_DE_CANAL[r.marketplace] ?? r.marketplace;
        return r.account ? `${canal} (${r.account})` : canal;
    }

    private async aplicar(enlace: ListingLink, accion: AccionDeCanal): Promise<ResultadoDeCanal> {
        const base = {
            linkId: enlace.id,
            marketplace: enlace.marketplace,
            connectionId: enlace.connection?.id ?? null,
            account: enlace.connection?.label || enlace.connection?.externalNickname || null,
        };
        try {
            if (!enlace.connection) throw new Error('La cuenta del canal está desconectada.');
            if (enlace.marketplace === 'mercadolibre') await this.enMercadoLibre(enlace, accion);
            else if (enlace.marketplace === 'falabella') await this.enFalabella(enlace, accion);
            else return { ...base, ok: false, message: 'Este canal todavía no se puede controlar desde Synkro.' };
            return { ...base, ok: true, message: 'Listo' };
        } catch (error: any) {
            const detalle = error?.response?.data?.message ?? error?.response?.data?.error ?? error?.message ?? 'error desconocido';
            this.logger.warn(`No se pudo ${accion} ${enlace.marketplace} ${enlace.externalId}: ${detalle}`);
            enlace.lastError = String(detalle).slice(0, 500);
            await this.listingLinkRepository.save(enlace);
            return { ...base, ok: false, message: String(detalle).slice(0, 300) };
        }
    }

    // ── Mercado Libre ─────────────────────────────────────────────

    private async enMercadoLibre(enlace: ListingLink, accion: AccionDeCanal): Promise<void> {
        const conexion = await this.sync.getValidConnectionById(enlace.connection!.id);
        const estado = accion === 'pause' ? 'paused' : accion === 'resume' ? 'active' : 'closed';
        await this.meliApi.setItemStatus(conexion.accessToken, enlace.externalId, estado);

        // El estado es de toda la publicación: si tiene variantes, todos sus enlaces cambian a la vez.
        const hermanos = enlace.variationId
            ? await this.listingLinkRepository.find({ where: { externalId: enlace.externalId, connection: { id: enlace.connection!.id } } })
            : [enlace];
        const afectados = hermanos.length ? hermanos : [enlace];
        for (const e of afectados) {
            this.marcar(e, accion);
            await this.listingLinkRepository.save(e);
        }

        if (accion === 'resume') {
            // Mientras estuvo pausada no se enviaron cambios de stock ni precio: se ponen al día.
            await this.sync.pushInventoryToMeli(enlace.product.id, enlace.connection!.id).catch((error: any) => this.logger.warn(`Reanudada, pero no se pudo actualizar el stock: ${error?.message}`));
        }
    }

    // ── Falabella ─────────────────────────────────────────────────

    private async enFalabella(enlace: ListingLink, accion: AccionDeCanal): Promise<void> {
        const credenciales = await this.sync.getFalabellaCredentials(enlace.connection!.id);
        const sku = enlace.product.sku;
        const ownerId = await this.duenoDeLaCuenta(enlace);

        if (accion === 'pause') {
            const feed = await this.falabellaApi.updateStock(credenciales, [{ sellerSku: sku, quantity: 0 }], { operatorCode: this.sync.falabellaOperatorCode });
            await this.sync.registrarFeedFalabella(ownerId, enlace.connection!.id, 'UpdateStock', sku, feed);
            this.marcar(enlace, 'pause');
            enlace.lastStockSynced = 0;
        } else if (accion === 'remove') {
            const feed = await this.falabellaApi.productRemove(credenciales, [sku]);
            await this.sync.registrarFeedFalabella(ownerId, enlace.connection!.id, 'ProductRemove', sku, feed);
            this.marcar(enlace, 'remove');
        } else {
            this.marcar(enlace, 'resume');
            enlace.lastStockSynced = null as any; // fuerza a enviar el stock real
        }
        await this.listingLinkRepository.save(enlace);

        if (accion === 'resume') await this.sync.pushInventoryToFalabella(enlace.product.id, enlace.connection!.id);
    }

    private async duenoDeLaCuenta(enlace: ListingLink): Promise<string> {
        const conBase = await this.listingLinkRepository.findOne({ where: { id: enlace.id }, relations: { connection: { owner: true } } });
        const id = conBase?.connection?.owner?.id;
        if (!id) throw new Error('No se encontró el dueño de la cuenta del canal.');
        return id;
    }

    private marcar(enlace: ListingLink, accion: AccionDeCanal): void {
        enlace.lastError = null as any;
        if (accion === 'pause') { enlace.pausedByUser = true; enlace.syncStatus = 'paused'; }
        else if (accion === 'resume') { enlace.pausedByUser = false; enlace.syncStatus = 'published'; }
        else { enlace.pausedByUser = false; enlace.syncStatus = 'removed'; }
    }
}
