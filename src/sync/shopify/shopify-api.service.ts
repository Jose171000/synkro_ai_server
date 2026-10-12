import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import {
    ChannelAuth,
    ChannelClient,
    ChannelListingRow,
    ChannelListingsResult,
    ChannelOrder,
    ChannelOrdersQuery,
    ChannelOrdersResult,
} from '../channels/channel-types';
import { filasDeProductoShopify, normalizarPedidoShopify } from './shopify-mapping';

const API_VERSION = '2025-01';
const MAX_PRODUCTOS = 5000;
const MAX_REINTENTOS_THROTTLE = 3;

export const SCOPES_SHOPIFY = [
    'read_products', 'write_products', 'read_inventory', 'write_inventory', 'read_orders', 'read_locations',
];

/**
 * Deja el dominio en la forma «mitienda.myshopify.com». Acepta el nombre solo,
 * el dominio completo o una dirección con https:// y rutas (/admin...).
 */
export function normalizarDominioShopify(site: string): string {
    let s = String(site ?? '').trim().toLowerCase();
    s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].trim();
    if (!s) throw new BadRequestException('Falta el dominio de la tienda Shopify (por ejemplo mitienda.myshopify.com).');
    if (s.endsWith('.myshopify.com')) return s;
    if (s.includes('.')) {
        throw new BadRequestException(
            `«${s}» no es un dominio *.myshopify.com. Shopify necesita el dominio interno de la tienda: ` +
            'lo encuentras en Configuración → Dominios (termina en .myshopify.com).',
        );
    }
    return `${s}.myshopify.com`;
}

/** Traduce un error de Shopify (HTTP, red o GraphQL) a un mensaje claro en español. */
export function describirErrorShopify(error: any): string {
    const status = error?.response?.status;
    const data = error?.response?.data;
    if (status === 401) {
        return 'Shopify rechazó el token. Revisa que sea el token de acceso de la Admin API (empieza por shpat_) y que la app esté instalada.';
    }
    if (status === 403) {
        return `Shopify negó el acceso: faltan permisos en la app. Necesita estos permisos: ${SCOPES_SHOPIFY.join(', ')}.`;
    }
    if (status === 404) {
        return 'Shopify no encontró la tienda. Revisa que el dominio sea el correcto (mitienda.myshopify.com).';
    }
    if (status === 423 || status === 402) {
        return 'La tienda de Shopify está cerrada o pausada (plan sin pagar o tienda congelada).';
    }
    if (status === 429) return 'Shopify limitó las peticiones. Inténtalo de nuevo en unos segundos.';
    if (typeof data === 'string' && /<html|<!doctype/i.test(data)) {
        return 'Shopify devolvió una página web en vez de datos. Revisa que el dominio sea el correcto (mitienda.myshopify.com).';
    }
    if (!error?.response && (error?.code || error?.request)) {
        return `No se pudo contactar con Shopify (${error?.code || error?.message || 'error de red'}). Revisa el dominio y tu conexión.`;
    }
    const errores = data?.errors ?? error?.errors;
    if (typeof errores === 'string') return `Shopify respondió con un error: ${errores}`;
    if (Array.isArray(errores) && errores.length) {
        return `Shopify respondió con un error: ${errores.map((e: any) => e?.message ?? String(e)).join('; ')}`;
    }
    return `Error de Shopify${status ? ` (HTTP ${status})` : ''}: ${error?.message || 'error desconocido'}`;
}

const PRODUCTOS_QUERY = `
query Productos($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title status onlineStoreUrl
      featuredImage { url }
      images(first: 5) { nodes { url } }
      variants(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id sku title price compareAtPrice inventoryQuantity
          selectedOptions { name value }
          image { url }
        }
      }
    }
  }
}`;

const PEDIDOS_QUERY = `
query Pedidos($cursor: String, $filtro: String) {
  orders(first: 50, after: $cursor, sortKey: CREATED_AT, reverse: true, query: $filtro) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt cancelledAt processedAt note email phone
      displayFinancialStatus displayFulfillmentStatus
      paymentGatewayNames
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      customer { firstName lastName email phone }
      shippingAddress { name address1 address2 city province zip country phone }
      lineItems(first: 100) {
        nodes {
          id title quantity sku
          variant { id }
          product { id }
          originalUnitPriceSet { shopMoney { amount } }
          discountedUnitPriceSet { shopMoney { amount } }
        }
      }
      fulfillments { trackingInfo { number company } }
    }
  }
}`;

const esperar = (ms: number) => new Promise(r => setTimeout(r, ms));

@Injectable()
export class ShopifyApiService implements ChannelClient {
    readonly channel = 'shopify' as const;
    private readonly logger = new Logger(ShopifyApiService.name);

    /** POST GraphQL; reintenta si Shopify limita por costo (THROTTLED). */
    private async graphql(auth: ChannelAuth, query: string, variables: Record<string, any> = {}): Promise<any> {
        const dominio = normalizarDominioShopify(auth.site);
        const url = `https://${dominio}/admin/api/${API_VERSION}/graphql.json`;

        for (let intento = 0; ; intento++) {
            let respuesta: any;
            try {
                respuesta = await axios.post(url, { query, variables }, {
                    timeout: 20000,
                    headers: {
                        'X-Shopify-Access-Token': auth.token,
                        'Content-Type': 'application/json',
                    },
                });
            } catch (error: any) {
                throw new BadRequestException(describirErrorShopify(error));
            }

            const cuerpo = respuesta?.data;
            if (typeof cuerpo === 'string') {
                throw new BadRequestException(describirErrorShopify({ response: { status: respuesta?.status, data: cuerpo } }));
            }
            const errores: any[] = Array.isArray(cuerpo?.errors) ? cuerpo.errors : [];
            if (errores.length) {
                const limitado = errores.some(e => e?.extensions?.code === 'THROTTLED');
                if (limitado && intento < MAX_REINTENTOS_THROTTLE) {
                    await esperar(1000);
                    continue;
                }
                const mensaje = errores.map(e => e?.message ?? String(e)).join('; ');
                throw new BadRequestException(
                    limitado
                        ? 'Shopify sigue limitando las peticiones. Inténtalo de nuevo en unos segundos.'
                        : `Shopify respondió con un error: ${mensaje}`,
                );
            }
            return cuerpo?.data ?? {};
        }
    }

    async verify(auth: ChannelAuth) {
        const data = await this.graphql(auth, '{ shop { name myshopifyDomain currencyCode } }');
        const tienda = data?.shop;
        if (!tienda?.myshopifyDomain) {
            throw new BadRequestException('Shopify no devolvió los datos de la tienda. Revisa el dominio y el token.');
        }

        let concedidos: string[] | null = null;
        try {
            const r = await this.graphql(auth, '{ currentAppInstallation { accessScopes { handle } } }');
            const lista = r?.currentAppInstallation?.accessScopes;
            if (Array.isArray(lista)) concedidos = lista.map((s: any) => String(s?.handle));
        } catch (e: any) {
            this.logger.warn(`No se pudieron comprobar los permisos de Shopify: ${e?.message}`);
        }
        if (concedidos) {
            // En Shopify, write_X incluye read_X.
            const faltan = SCOPES_SHOPIFY.filter(s => {
                if (concedidos!.includes(s)) return false;
                if (s.startsWith('read_') && concedidos!.includes(`write_${s.slice(5)}`)) return false;
                return true;
            });
            if (faltan.length) {
                throw new BadRequestException(
                    `A la app de Shopify le faltan permisos: ${faltan.join(', ')}. Añádelos en la configuración de la app y vuelve a instalarla.`,
                );
            }
        }

        return {
            accountId: String(tienda.myshopifyDomain).toLowerCase(),
            nickname: String(tienda.name ?? tienda.myshopifyDomain),
            currency: tienda.currencyCode ? String(tienda.currencyCode) : null,
        };
    }

    async listListings(auth: ChannelAuth): Promise<ChannelListingsResult> {
        const rows: ChannelListingRow[] = [];
        let sinSku = 0;
        let productos = 0;
        let incompleto = false;
        let moneda: string | null = null;
        try {
            const d = await this.graphql(auth, '{ shop { currencyCode } }');
            moneda = d?.shop?.currencyCode ?? null;
        } catch { /* la moneda es opcional */ }

        let cursor: string | null = null;
        for (;;) {
            const data = await this.graphql(auth, PRODUCTOS_QUERY, { cursor });
            const pagina = data?.products;
            const nodos: any[] = Array.isArray(pagina?.nodes) ? pagina.nodes : [];
            let tope = false;
            for (const p of nodos) {
                if (productos >= MAX_PRODUCTOS) { tope = true; break; }
                productos++;
                if (p?.variants?.pageInfo?.hasNextPage) incompleto = true;
                const r = filasDeProductoShopify(p, moneda);
                rows.push(...r.rows);
                sinSku += r.sinSku;
            }
            const hayMas = !!pagina?.pageInfo?.hasNextPage && !!pagina?.pageInfo?.endCursor;
            if (tope || (productos >= MAX_PRODUCTOS && hayMas)) { incompleto = true; break; }
            if (!hayMas) break;
            cursor = pagina.pageInfo.endCursor;
        }
        return { rows, sinSku, productos, incompleto };
    }

    async setInventory(
        auth: ChannelAuth,
        target: { externalId: string; variationId: string | null },
        values: { stock: number; price?: number | null },
    ): Promise<void> {
        let variationId = target.variationId;
        if (!variationId) {
            if (!target.externalId) throw new BadRequestException('Falta el producto de Shopify que se quiere actualizar.');
            const d = await this.graphql(
                auth,
                'query($id: ID!) { product(id: $id) { variants(first: 1) { nodes { id } } } }',
                { id: `gid://shopify/Product/${target.externalId}` },
            );
            variationId = String(d?.product?.variants?.nodes?.[0]?.id ?? '').split('/').pop() || null;
            if (!variationId) throw new BadRequestException('No se encontró ninguna variante para el producto de Shopify.');
        }
        const gidVariante = `gid://shopify/ProductVariant/${variationId}`;

        const d = await this.graphql(
            auth,
            'query($id: ID!) { productVariant(id: $id) { id inventoryItem { id inventoryLevels(first: 5) { nodes { location { id isActive } } } } } }',
            { id: gidVariante },
        );
        const variante = d?.productVariant;
        if (!variante) throw new BadRequestException('Shopify no encontró la variante que se quiere actualizar.');
        const niveles: any[] = variante?.inventoryItem?.inventoryLevels?.nodes ?? [];
        const nivel = niveles.find(n => n?.location?.isActive !== false && n?.location?.id);
        if (!variante?.inventoryItem?.id || !nivel) {
            throw new BadRequestException('Esta variante no tiene inventario en ninguna ubicación.');
        }

        const stock = Math.max(0, Math.trunc(Number(values.stock) || 0));
        const inv = await this.graphql(
            auth,
            'mutation($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { field message } } }',
            {
                input: {
                    name: 'available',
                    reason: 'correction',
                    ignoreCompareQuantity: true,
                    quantities: [{ inventoryItemId: variante.inventoryItem.id, locationId: nivel.location.id, quantity: stock }],
                },
            },
        );
        this.lanzarSiHayErrores(inv?.inventorySetQuantities?.userErrors, 'cambiar el stock');

        if (values.price !== undefined && values.price !== null) {
            const precio = await this.graphql(
                auth,
                'mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }',
                {
                    productId: `gid://shopify/Product/${target.externalId}`,
                    variants: [{ id: gidVariante, price: Number(values.price).toFixed(2) }],
                },
            );
            this.lanzarSiHayErrores(precio?.productVariantsBulkUpdate?.userErrors, 'cambiar el precio');
        }
    }

    private lanzarSiHayErrores(errores: any, accion: string) {
        if (Array.isArray(errores) && errores.length) {
            throw new BadRequestException(
                `Shopify no pudo ${accion}: ${errores.map((e: any) => e?.message ?? String(e)).join('; ')}`,
            );
        }
    }

    /**
     * Nota: sin el permiso read_all_orders, Shopify solo entrega los pedidos
     * de los últimos 60 días, aunque se pida un rango anterior.
     */
    async listOrders(auth: ChannelAuth, query: ChannelOrdersQuery): Promise<ChannelOrdersResult> {
        const partes: string[] = [];
        if (query.createdFrom) partes.push(`created_at:>=${query.createdFrom.toISOString()}`);
        if (query.createdTo) partes.push(`created_at:<=${query.createdTo.toISOString()}`);
        if (query.updatedFrom) partes.push(`updated_at:>=${query.updatedFrom.toISOString()}`);
        const filtro = partes.length ? partes.join(' AND ') : null;

        const orders: ChannelOrder[] = [];
        let incompleto = false;
        let cursor: string | null = null;
        for (;;) {
            const data = await this.graphql(auth, PEDIDOS_QUERY, { cursor, filtro });
            const pagina = data?.orders;
            const nodos: any[] = Array.isArray(pagina?.nodes) ? pagina.nodes : [];
            const hayMas = !!pagina?.pageInfo?.hasNextPage && !!pagina?.pageInfo?.endCursor;
            for (const n of nodos) {
                if (orders.length >= query.max) { incompleto = true; break; }
                orders.push(normalizarPedidoShopify(n));
            }
            if (incompleto) break;
            if (!hayMas) break;
            if (orders.length >= query.max) { incompleto = true; break; }
            cursor = pagina.pageInfo.endCursor;
        }
        return { orders, incompleto };
    }
}
