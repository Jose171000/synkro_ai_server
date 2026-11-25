import { HttpException, Injectable, Logger } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ProductsService } from '../products/products.service';
import { OrdersQueryService } from '../sync/orders-query.service';
import { ProductOverviewService } from '../sync/product-overview.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { ReportsService } from '../reports/reports.service';
import { ChangeRequestsService } from '../sync/change-requests.service';
import { AccesoMcp, ApiKeysService } from './api-keys.service';
import { ProductGroupsService } from '../products/product-groups.service';
import { UploadService } from '../upload/upload.service';
import { aTexto, HERRAMIENTAS, HerramientaMcp, ServiciosMcp } from './mcp-tools';
import { HERRAMIENTAS_DE_ESCRITURA, HerramientaDeEscritura } from './mcp-write-tools';
import { McpEscriturasService } from './mcp-escrituras.service';

/** La clave que llega como `Authorization: Bearer syk_...`. */
export function claveDeLaCabecera(cabecera: string | undefined): string | undefined {
    const m = /^Bearer\s+(\S+)$/i.exec(cabecera ?? '');
    return m?.[1];
}

/** Las herramientas que esta clave puede usar: solo las de permisos que tiene, para que el modelo no vea ni intente el resto. */
export const herramientasPermitidas = (acceso: Pick<AccesoMcp, 'permissions'>): HerramientaMcp[] =>
    [...HERRAMIENTAS, ...HERRAMIENTAS_DE_ESCRITURA].filter((h) => acceso.permissions.includes(h.permiso));

const esDeEscritura = (h: HerramientaMcp): h is HerramientaDeEscritura => (h as HerramientaDeEscritura).escribe === true;

@Injectable()
export class McpService {
    private readonly logger = new Logger(McpService.name);
    /** Los servicios de las herramientas de tienda; el MCP de plataforma los reutiliza. */
    readonly servicios: ServiciosMcp;

    constructor(
        private readonly keys: ApiKeysService,
        products: ProductsService,
        orders: OrdersQueryService,
        overview: ProductOverviewService,
        dashboard: DashboardService,
        reports: ReportsService,
        changes: ChangeRequestsService,
        groups: ProductGroupsService,
        upload: UploadService,
        private readonly escrituras: McpEscriturasService,
    ) {
        this.servicios = { products, orders, overview, dashboard, reports, changes, groups, upload };
    }

    autenticar(cabecera: string | undefined) {
        return this.keys.autenticar(claveDeLaCabecera(cabecera));
    }

    /** Un servidor MCP por petición (sin sesión): el acceso de la clave se comprueba de nuevo en cada llamada. */
    crearServidor(acceso: AccesoMcp): McpServer {
        const servidor = new McpServer({ name: 'synkro', version: '1.0.0' });
        for (const h of herramientasPermitidas(acceso)) {
            servidor.registerTool(
                h.name,
                {
                    title: h.title,
                    description: h.description,
                    inputSchema: h.input,
                    annotations: esDeEscritura(h)
                        ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
                        : { readOnlyHint: true, openWorldHint: false },
                },
                async (args: any) => {
                    try {
                        // Doble comprobación: aunque la herramienta se registró, el permiso se exige también al ejecutarla.
                        if (!acceso.permissions.includes(h.permiso)) return this.fallo('Esta clave no tiene permiso para esta herramienta.');
                        const hacer = () => h.ejecutar(this.servicios, acceso, args);
                        const resultado = esDeEscritura(h)
                            ? await this.escrituras.ejecutar(acceso, { herramienta: h.name, args, resumen: h.resumen(args), unaSolaVez: h.unaSolaVez, usaIa: h.usaIa }, hacer)
                            : await hacer();
                        this.logger.log(`${h.name} · clave «${acceso.keyName}» · tienda ${acceso.storeId}`);
                        return { content: [{ type: 'text' as const, text: aTexto(resultado) }] };
                    } catch (error: any) {
                        // Los mensajes de la app (en español) se muestran tal cual; cualquier otro error, genérico.
                        if (error instanceof HttpException) return this.fallo(mensajeDe(error));
                        this.logger.error(`${h.name} falló: ${error?.message}`);
                        return this.fallo(esDeEscritura(h)
                            ? 'No se pudo completar el cambio. Antes de repetirlo, comprueba con listar_productos si llegó a hacerse.'
                            : 'No se pudo completar la consulta. Inténtalo de nuevo.');
                    }
                },
            );
        }
        return servidor;
    }

    atender(acceso: AccesoMcp, req: any, res: any): Promise<void> {
        return atenderMcp(this.crearServidor(acceso), req, res);
    }

    private fallo(texto: string) {
        return resultadoConError(texto);
    }
}

/** Atiende UNA petición con un servidor MCP sin sesión (Streamable HTTP, respuesta JSON). Lo usan el MCP de tienda y el de plataforma. */
export async function atenderMcp(servidor: McpServer, req: any, res: any): Promise<void> {
    const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
        void transporte.close();
        void servidor.close();
    });
    await servidor.connect(transporte);
    await transporte.handleRequest(req, res, req.body);
}

export const resultadoConError = (texto: string) => ({ isError: true, content: [{ type: 'text' as const, text: texto }] });

export function mensajeDe(error: HttpException): string {
    const r: any = error.getResponse();
    const m = typeof r === 'string' ? r : r?.message;
    return Array.isArray(m) ? m.join(' ') : String(m ?? error.message);
}
