import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { ApiKeysService } from './api-keys.service';
import { TransformInterceptor, esRutaDeProtocolo } from '../common/interceptors/transform.interceptor';

const CABECERAS = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };

describe('POST /api/v1/mcp (HTTP real, sin base de datos)', () => {
    let app: INestApplication;
    const findAll = jest.fn().mockResolvedValue({ data: [{ id: 'p1', name: 'Zapatilla', sku: 'Z1', price: 99, stock: 4, images: [] }], meta: { total: 1 } });
    const autenticar = jest.fn(async (clave?: string) => {
        if (clave !== 'syk_buena') throw new UnauthorizedException();
        return { keyId: 'k', keyName: 'Prueba', userId: 'u1', storeId: 's1', role: 'viewer', permissions: ['productos.ver'] };
    });

    beforeAll(async () => {
        const modulo = await Test.createTestingModule({
            imports: [ThrottlerModule.forRoot([{ name: 'short', ttl: 1000, limit: 1000 }, { name: 'medium', ttl: 60_000, limit: 1000 }])],
            controllers: [McpController],
            providers: [
                { provide: ApiKeysService, useValue: { autenticar } },
                { provide: McpService, useFactory: () => new McpService({ autenticar } as any, { findAll } as any, {} as any, {} as any, {} as any, {} as any, {} as any) },
                { provide: APP_GUARD, useClass: ThrottlerGuard },
            ],
        }).compile();
        app = modulo.createNestApplication();
        app.setGlobalPrefix('api/v1');
        app.useGlobalInterceptors(new TransformInterceptor());
        await app.init();
    });
    afterAll(() => app.close());

    const rpc = (cuerpo: object, clave = 'syk_buena') =>
        request(app.getHttpServer()).post('/api/v1/mcp').set(CABECERAS).set('Authorization', `Bearer ${clave}`).send(cuerpo);

    it('sin clave o con una mala responde 401 sin envolver', async () => {
        const r = await request(app.getHttpServer()).post('/api/v1/mcp').set(CABECERAS).send({});
        expect(r.status).toBe(401);
        expect(r.headers['www-authenticate']).toBe('Bearer');
        expect(r.body).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: 'Clave inválida, caducada o revocada.' }, id: null });
        expect((await rpc({}, 'syk_mala')).status).toBe(401);
    });

    it('responde initialize y tools/list en JSON-RPC puro (sin data/statusCode)', async () => {
        const ini = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
        expect(ini.status).toBe(200);
        expect(ini.body.result.serverInfo.name).toBe('synkro');
        expect(ini.body).not.toHaveProperty('statusCode');

        const lista = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        expect(lista.body.result.tools.map((t: any) => t.name).sort()).toEqual(['listar_productos', 'ver_producto']);
    });

    it('llama una herramienta con la tienda de la clave', async () => {
        const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'listar_productos', arguments: { search: 'zap' } } });
        expect(r.status).toBe(200);
        expect(r.body.result.content[0].text).toContain('Zapatilla');
        expect(findAll).toHaveBeenCalledWith({ userId: 'u1', storeId: 's1' }, expect.objectContaining({ search: 'zap' }));
    });

    it('una herramienta que la clave no tiene responde error de protocolo', async () => {
        const r = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'listar_ventas', arguments: {} } });
        expect(r.body.error ?? r.body.result?.isError).toBeTruthy();
    });

    it('GET y DELETE responden 405', async () => {
        expect((await request(app.getHttpServer()).get('/api/v1/mcp')).status).toBe(405);
        expect((await request(app.getHttpServer()).delete('/api/v1/mcp')).status).toBe(405);
    });
});

describe('TransformInterceptor y el MCP', () => {
    it('solo deja pasar la ruta del protocolo', () => {
        expect(esRutaDeProtocolo('/api/v1/mcp')).toBe(true);
        expect(esRutaDeProtocolo('/api/v1/mcp?x=1')).toBe(true);
        expect(esRutaDeProtocolo('/api/v1/mcpx')).toBe(false);
        expect(esRutaDeProtocolo('/api/v1/products')).toBe(false);
        expect(esRutaDeProtocolo(undefined)).toBe(false);
    });
});
