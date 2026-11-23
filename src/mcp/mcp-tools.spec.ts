import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HERRAMIENTAS, MAX_CARACTERES, aTexto, resumenDeProducto } from './mcp-tools';
import { PERMISOS_MCP } from './api-keys.service';
import { McpService, claveDeLaCabecera, herramientasPermitidas } from './mcp.service';
import { ForbiddenException } from '@nestjs/common';

/** Tabla fijada a propósito: cambiar el permiso de una herramienta, o agregar una sin permiso, hace fallar esta prueba. */
const PERMISO_POR_HERRAMIENTA: Record<string, string> = {
    listar_productos: 'productos.ver',
    ver_producto: 'productos.ver',
    listar_ventas: 'ventas.ver',
    ver_venta: 'ventas.ver',
    resumen_negocio: 'analiticas.ver',
    reporte_ventas: 'analiticas.ver',
    productos_ganadores: 'analiticas.ver',
    listar_cambios_pendientes: 'canales.ver',
};

describe('herramientas del MCP', () => {
    it('cada herramienta exige el permiso fijado, y todos son de lectura', () => {
        expect(Object.fromEntries(HERRAMIENTAS.map((h) => [h.name, h.permiso]))).toEqual(PERMISO_POR_HERRAMIENTA);
        for (const h of HERRAMIENTAS) expect(PERMISOS_MCP).toContain(h.permiso);
    });

    it('los nombres no se repiten', () => {
        expect(new Set(HERRAMIENTAS.map((h) => h.name)).size).toBe(HERRAMIENTAS.length);
    });

    it('una clave solo ve las herramientas de sus permisos', () => {
        const nombres = herramientasPermitidas({ permissions: ['productos.ver'] }).map((h) => h.name);
        expect(nombres).toEqual(['listar_productos', 'ver_producto']);
        expect(herramientasPermitidas({ permissions: [] })).toEqual([]);
    });

    it('el resumen de producto no filtra datos internos', () => {
        const r = resumenDeProducto({ id: 'p', name: 'N', sku: 'S', price: '10.5', stock: 3, aiAttributes: { x: 1 }, owner: { id: 'u' }, marketplaceIds: { a: 1 }, images: [{ url: 'http://f' }] });
        expect(r).toMatchObject({ id: 'p', price: 10.5, image: 'http://f' });
        expect(JSON.stringify(r)).not.toMatch(/aiAttributes|owner|marketplaceIds/);
    });

    it('recorta las respuestas demasiado grandes', () => {
        expect(aTexto({ x: 'a'.repeat(MAX_CARACTERES * 2) })).toMatch(/respuesta recortada/);
        expect(aTexto({ a: 1 })).toContain('"a": 1');
    });
});

describe('cabecera de la clave', () => {
    it('lee Bearer y nada más', () => {
        expect(claveDeLaCabecera('Bearer syk_abc')).toBe('syk_abc');
        expect(claveDeLaCabecera('bearer syk_abc')).toBe('syk_abc');
        expect(claveDeLaCabecera('Basic syk_abc')).toBeUndefined();
        expect(claveDeLaCabecera('Bearer')).toBeUndefined();
        expect(claveDeLaCabecera(undefined)).toBeUndefined();
    });
});

async function conectar(permissions: string[], servicios: any = {}) {
    const mcp = new McpService({} as any, servicios.products, servicios.orders, servicios.overview, servicios.dashboard, servicios.reports, servicios.changes);
    const acceso: any = { keyId: 'k', keyName: 'Prueba', userId: 'u1', storeId: 's1', role: 'viewer', permissions };
    const [a, b] = InMemoryTransport.createLinkedPair();
    const servidor = mcp.crearServidor(acceso);
    await servidor.connect(a);
    const cliente = new Client({ name: 'test', version: '1' });
    await cliente.connect(b);
    return cliente;
}

const texto = (r: any) => r.content[0].text as string;

describe('servidor MCP de punta a punta (en memoria)', () => {
    it('anuncia solo las herramientas permitidas', async () => {
        const c = await conectar(['ventas.ver']);
        const { tools } = await c.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(['listar_ventas', 'ver_venta']);
        expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    });

    it('una herramienta fuera de los permisos no se puede llamar', async () => {
        const c = await conectar(['productos.ver']);
        const r: any = await c.callTool({ name: 'listar_ventas', arguments: {} }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
        expect(r.isError).toBe(true);
    });

    it('listar_productos pasa la tienda y la clave, limita la página y resume cada producto', async () => {
        const findAll = jest.fn().mockResolvedValue({ data: [{ id: 'p1', name: 'Zapatilla', sku: 'Z1', price: 99, stock: 4, aiAttributes: { secreto: 1 }, images: [] }], meta: { total: 1, page: 1, limit: 50 } });
        const c = await conectar(['productos.ver'], { products: { findAll } });
        const r = await c.callTool({ name: 'listar_productos', arguments: { search: 'zap', limit: 50 } });
        expect(findAll).toHaveBeenCalledWith({ userId: 'u1', storeId: 's1' }, expect.objectContaining({ search: 'zap', limit: 50, page: 1 }));
        expect(texto(r)).toContain('Zapatilla');
        expect(texto(r)).not.toContain('secreto');
    });

    it('rechaza un límite por encima del máximo antes de llegar al servicio', async () => {
        const findAll = jest.fn();
        const c = await conectar(['productos.ver'], { products: { findAll } });
        const r: any = await c.callTool({ name: 'listar_productos', arguments: { limit: 5000 } }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
        expect(r.isError).toBe(true);
        expect(findAll).not.toHaveBeenCalled();
    });

    it('listar_ventas entrega el acceso real de la clave, para que el contacto salga solo con su permiso', async () => {
        const list = jest.fn().mockResolvedValue({ total: 0, items: [] });
        const c = await conectar(['ventas.ver'], { orders: { list } });
        await c.callTool({ name: 'listar_ventas', arguments: { status: 'pendiente' } });
        expect(list).toHaveBeenCalledWith('s1', { role: 'viewer', permissions: ['ventas.ver'] }, expect.objectContaining({ status: 'pendiente', limit: 20 }));
    });

    it('reporte_ventas no suma costos si la clave no tiene costos.ver', async () => {
        const getSalesReport = jest.fn().mockResolvedValue({});
        const c = await conectar(['analiticas.ver'], { reports: { getSalesReport } });
        await c.callTool({ name: 'reporte_ventas', arguments: {} });
        expect(getSalesReport).toHaveBeenCalledWith('s1', undefined, undefined, undefined, true, false, undefined);
    });

    it('resumen_negocio quita los avisos personales de quien creó la clave', async () => {
        const getSummary = jest.fn().mockResolvedValue({ canales: [], avisos: { sinLeer: 3 } });
        const c = await conectar(['analiticas.ver'], { dashboard: { getSummary } });
        expect(texto(await c.callTool({ name: 'resumen_negocio', arguments: {} }))).not.toContain('avisos');
    });

    it('listar_cambios_pendientes no expone a quien pidió el cambio', async () => {
        const list = jest.fn().mockResolvedValue([{ id: 'c1', status: 'pending', field: 'price', marketplace: 'falabella', newValue: '10', requestedBy: { id: 'u9', email: 'x@y.z' }, product: { id: 'p', name: 'N', sku: 'S' } }]);
        const c = await conectar(['canales.ver'], { changes: { list } });
        const t = texto(await c.callTool({ name: 'listar_cambios_pendientes', arguments: {} }));
        expect(t).toContain('"valorNuevo": "10"');
        expect(t).not.toMatch(/x@y\.z|requestedBy|u9/);
    });

    it('un error de la app llega en español; uno inesperado, genérico y sin detalles', async () => {
        const c1 = await conectar(['ventas.ver'], { orders: { detail: jest.fn().mockRejectedValue(new ForbiddenException('Tu rol en esta tienda no permite esta acción.')) } });
        const r1: any = await c1.callTool({ name: 'ver_venta', arguments: { id: '11111111-1111-4111-8111-111111111111' } });
        expect(r1.isError).toBe(true);
        expect(texto(r1)).toBe('Tu rol en esta tienda no permite esta acción.');

        const c2 = await conectar(['ventas.ver'], { orders: { detail: jest.fn().mockRejectedValue(new Error('connection to db at 10.0.0.5 failed')) } });
        const r2: any = await c2.callTool({ name: 'ver_venta', arguments: { id: '11111111-1111-4111-8111-111111111111' } });
        expect(r2.isError).toBe(true);
        expect(texto(r2)).not.toContain('10.0.0.5');
    });
});
