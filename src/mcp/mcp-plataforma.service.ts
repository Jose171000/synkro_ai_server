import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type Redis from 'ioredis';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AdminService } from '../admin/admin.service';
import { BillingService } from '../admin/billing.service';
import { SignupsService } from '../admin/signups.service';
import { DashboardInsightsService } from '../dashboard/dashboard-insights.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { Store } from '../stores/entities/store.entity';
import { StoresService } from '../stores/stores.service';
import { AccesoMcp, AccesoPlataforma, ApiKeysService } from './api-keys.service';
import { aTexto } from './mcp-tools';
import { atenderMcp, claveDeLaCabecera, mensajeDe, McpService, resultadoConError } from './mcp.service';
import { permisosDeTiendaParaPlataforma } from './permisos-plataforma';
import { HERRAMIENTAS_DE_TIENDA_EN_PLATAFORMA, HERRAMIENTAS_PLATAFORMA, ServiciosPlataforma } from './platform-tools';

/** El MCP de plataforma se puede apagar entero con `MCP_PLATAFORMA_ACTIVO=false`, sin tocar el MCP de las tiendas. */
export const mcpPlataformaActivo = () => process.env.MCP_PLATAFORMA_ACTIVO !== 'false';

/** Las herramientas propias de la plataforma que estos permisos dejan usar. */
export const herramientasPlataformaPermitidas = (a: Pick<AccesoPlataforma, 'permissions'>) =>
    HERRAMIENTAS_PLATAFORMA.filter((h) => a.permissions.includes(h.permiso));

/** Las herramientas de tienda («tienda_…») que estos permisos dejan usar: depende de lo que la clave puede ver DENTRO de cada tienda. */
export const herramientasDeTiendaPermitidas = (a: Pick<AccesoPlataforma, 'permissions'>) => {
    const dentro = permisosDeTiendaParaPlataforma(a.permissions);
    return HERRAMIENTAS_DE_TIENDA_EN_PLATAFORMA.filter((h) => dentro.includes(h.permisoDeTienda as any));
};

@Injectable()
export class McpPlataformaService {
    private readonly logger = new Logger(McpPlataformaService.name);
    private readonly plataforma: ServiciosPlataforma;

    constructor(
        private readonly keys: ApiKeysService,
        private readonly stores: StoresService,
        private readonly mcpDeTienda: McpService,
        admin: AdminService,
        insights: DashboardInsightsService,
        billing: BillingService,
        signups: SignupsService,
        @InjectRepository(Store) storeRepo: Repository<Store>,
        @Inject(REDIS_CLIENT) redis: Redis,
    ) {
        this.plataforma = { admin, insights, billing, signups, stores: storeRepo, keys, redis };
    }

    autenticar(cabecera: string | undefined) {
        return this.keys.autenticarPlataforma(claveDeLaCabecera(cabecera));
    }

    crearServidor(acceso: AccesoPlataforma): McpServer {
        const servidor = new McpServer({ name: 'synkro-plataforma', version: '1.0.0' });
        const anotaciones = { readOnlyHint: true, openWorldHint: false };

        const envolver = (nombre: string, permitido: boolean, trabajo: (args: any) => Promise<unknown>) => async (args: any) => {
            try {
                // Doble comprobación: aunque la herramienta se registró, el permiso se exige también al ejecutarla.
                if (!permitido) return resultadoConError('Esta clave no tiene permiso para esta herramienta.');
                const resultado = await trabajo(args);
                this.logger.log(`${nombre} · clave de plataforma «${acceso.keyName}»`);
                return { content: [{ type: 'text' as const, text: aTexto(resultado) }] };
            } catch (error: any) {
                if (error instanceof HttpException) return resultadoConError(mensajeDe(error));
                this.logger.error(`${nombre} falló: ${error?.message}`);
                return resultadoConError('No se pudo completar la consulta. Inténtalo de nuevo.');
            }
        };

        for (const h of herramientasPlataformaPermitidas(acceso)) {
            servidor.registerTool(
                h.name,
                { title: h.title, description: h.description, inputSchema: h.input, annotations: anotaciones },
                envolver(h.name, acceso.permissions.includes(h.permiso), (args) => h.ejecutar(this.plataforma, acceso, args)),
            );
        }

        const dentro = permisosDeTiendaParaPlataforma(acceso.permissions);
        for (const h of herramientasDeTiendaPermitidas(acceso)) {
            servidor.registerTool(
                h.name,
                { title: h.title, description: h.description, inputSchema: h.input, annotations: anotaciones },
                envolver(h.name, dentro.includes(h.permisoDeTienda as any), async ({ tiendaId, ...args }) => {
                    // Un superadmin entra a cualquier tienda como dueño; esto solo comprueba que la tienda exista.
                    await this.stores.requireAccess(acceso.userId, tiendaId, 'viewer');
                    // Lo que ve DENTRO de la tienda lo fija la clave, nunca el rol de dueño: sin contacto de compradores.
                    const enLaTienda: AccesoMcp = { keyId: acceso.keyId, keyName: acceso.keyName, userId: acceso.userId, storeId: tiendaId, role: 'owner', permissions: dentro };
                    return h.original.ejecutar(this.mcpDeTienda.servicios, enLaTienda, args);
                }),
            );
        }
        return servidor;
    }

    atender(acceso: AccesoPlataforma, req: any, res: any): Promise<void> {
        return atenderMcp(this.crearServidor(acceso), req, res);
    }
}
