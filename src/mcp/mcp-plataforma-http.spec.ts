import { INestApplication, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as request from 'supertest';
import { McpPlataformaController } from './mcp-plataforma.controller';
import { McpPlataformaService } from './mcp-plataforma.service';
import { McpService } from './mcp.service';
import { AdminApiKeysController } from './admin-api-keys.controller';
import { ApiKeysController } from './api-keys.controller';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/user-role';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';

describe('/api/v1/mcp/admin (HTTP real)', () => {
    let app: INestApplication;
    let url: URL;
    const getFinanceSummary = jest.fn().mockResolvedValue({ mrr: 4305.08 });
    const autenticar = jest.fn(async (cabecera?: string) => {
        if (cabecera === 'Bearer sya_buena') return { keyId: 'k', keyName: 'Agencia', userId: 'admin1', permissions: ['clientes.ver', 'finanzas.ver'] };
        if (cabecera === 'Bearer sya_sinpermisos') throw new ForbiddenException('Esta clave no tiene permisos.');
        throw new UnauthorizedException();
    });

    beforeAll(async () => {
        const deTienda = new McpService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
        const modulo = await Test.createTestingModule({
            controllers: [McpPlataformaController],
            providers: [{ provide: McpPlataformaService, useFactory: () => {
                const s = new McpPlataformaService({} as any, {} as any, deTienda, { getFinanceSummary } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
                s.autenticar = autenticar as any;
                return s;
            } }],
        }).compile();
        app = modulo.createNestApplication();
        app.setGlobalPrefix('api/v1');
        app.useGlobalInterceptors(new TransformInterceptor());
        await app.listen(0, '127.0.0.1');
        url = new URL(`${await app.getUrl()}/api/v1/mcp/admin`);
    });
    afterAll(() => app.close());
    afterEach(() => { delete process.env.MCP_PLATAFORMA_ACTIVO; });

    const post = (cabecera?: string) => {
        const r = request(app.getHttpServer()).post('/api/v1/mcp/admin').set({ Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' });
        return (cabecera ? r.set('Authorization', cabecera) : r).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    };

    it('401 sin clave o con una mala, 403 si la clave no tiene permisos; sin envolver', async () => {
        const sin = await post();
        expect(sin.status).toBe(401);
        expect(sin.body.error.message).toBe('Clave inválida, caducada o revocada.');
        expect((await post('Bearer syk_deTienda')).status).toBe(401);
        expect((await post('Bearer sya_sinpermisos')).status).toBe(403);
    });

    it('el cliente oficial conecta, ve las herramientas permitidas y llama una', async () => {
        const c = new Client({ name: 'cliente', version: '1' });
        await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer sya_buena' } } }));
        expect(c.getServerVersion()?.name).toBe('synkro-plataforma');
        const { tools } = await c.listTools();
        const nombres = tools.map((t) => t.name);
        expect(nombres).toEqual(expect.arrayContaining(['listar_clientes', 'resumen_financiero', 'tienda_listar_ventas']));
        expect(nombres).not.toContain('estado_del_sistema');
        const r: any = await c.callTool({ name: 'resumen_financiero', arguments: {} });
        expect(r.content[0].text).toContain('4305.08');
        await c.close();
    });

    it('apagado con MCP_PLATAFORMA_ACTIVO=false: responde 404 y no llega a autenticar', async () => {
        process.env.MCP_PLATAFORMA_ACTIVO = 'false';
        autenticar.mockClear();
        expect((await post('Bearer sya_buena')).status).toBe(404);
        expect(autenticar).not.toHaveBeenCalled();
    });

    it('GET y DELETE responden 405', async () => {
        expect((await request(app.getHttpServer()).get('/api/v1/mcp/admin')).status).toBe(405);
        expect((await request(app.getHttpServer()).delete('/api/v1/mcp/admin')).status).toBe(405);
    });
});

describe('quién puede entrar a las rutas de claves', () => {
    it('/admin/api-keys es solo del rol admin', () => {
        expect(Reflect.getMetadata(ROLES_KEY, AdminApiKeysController)).toEqual([UserRole.ADMIN]);
    });

    it('las rutas de claves de una tienda no están restringidas por rol de plataforma: las gestiona el dueño de la tienda (se comprueba en el servicio)', () => {
        expect(Reflect.getMetadata(ROLES_KEY, ApiKeysController)).toBeUndefined();
    });
});
