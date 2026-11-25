import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';

/**
 * El cliente OFICIAL del SDK (el mismo protocolo que usan Claude Code, Claude Desktop y Cursor) contra un servidor HTTP real
 * escuchando en un puerto: el apretón de manos completo (initialize → initialized → tools/list → tools/call), no peticiones sueltas.
 */
describe('cliente MCP real contra el endpoint', () => {
    let app: INestApplication;
    let url: URL;
    const findAll = jest.fn().mockResolvedValue({ data: [{ id: 'p1', name: 'Zapatilla', sku: 'Z1', price: 99, stock: 4, images: [] }], meta: { total: 1 } });
    const getSalesReport = jest.fn().mockResolvedValue({ total: 1234 });
    const autenticar = jest.fn(async (cabecera?: string) => {
        if (cabecera === 'Bearer syk_lector') return { keyId: 'k', keyName: 'Lector', userId: 'u1', storeId: 's1', role: 'viewer', permissions: ['productos.ver', 'analiticas.ver'] };
        throw new UnauthorizedException();
    });

    beforeAll(async () => {
        const modulo = await Test.createTestingModule({
            controllers: [McpController],
            providers: [{ provide: McpService, useFactory: () => {
                const s = new McpService({} as any, { findAll } as any, {} as any, {} as any, {} as any, { getSalesReport } as any, {} as any, {} as any, {} as any, {} as any);
                s.autenticar = autenticar as any;
                return s;
            } }],
        }).compile();
        app = modulo.createNestApplication();
        app.setGlobalPrefix('api/v1');
        app.useGlobalInterceptors(new TransformInterceptor());
        await app.listen(0, '127.0.0.1');
        url = new URL(`${await app.getUrl()}/api/v1/mcp`);
    });
    afterAll(() => app.close());

    const conectar = async (clave: string) => {
        const cliente = new Client({ name: 'cliente-de-prueba', version: '1.0.0' });
        await cliente.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${clave}` } } }));
        return cliente;
    };

    it('conecta, descubre solo las herramientas permitidas y las llama', async () => {
        const c = await conectar('syk_lector');
        expect(c.getServerVersion()?.name).toBe('synkro');

        const { tools } = await c.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(['listar_productos', 'productos_ganadores', 'reporte_ventas', 'resumen_negocio', 'ver_producto']);
        expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);

        const r: any = await c.callTool({ name: 'listar_productos', arguments: { search: 'zap' } });
        expect(r.isError).toBeFalsy();
        expect(r.content[0].text).toContain('Zapatilla');

        const v: any = await c.callTool({ name: 'reporte_ventas', arguments: { from: '2026-10-01', to: '2026-10-31' } });
        expect(v.content[0].text).toContain('1234');
        // La clave no tiene costos.ver: el reporte se pide sin costos y sin sumar el envío que no puede ver.
        expect(getSalesReport).toHaveBeenCalledWith('s1', '2026-10-01', '2026-10-31', undefined, true, false, undefined);
        await c.close();
    });

    it('una fecha mal escrita se rechaza con un mensaje claro, sin llegar al servicio', async () => {
        const c = await conectar('syk_lector');
        const r: any = await c.callTool({ name: 'reporte_ventas', arguments: { from: '01/10/2026' } }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toMatch(/AAAA-MM-DD/);
        await c.close();
    });

    it('una clave mala no puede conectar', async () => {
        await expect(conectar('syk_mala')).rejects.toThrow();
    });
});
