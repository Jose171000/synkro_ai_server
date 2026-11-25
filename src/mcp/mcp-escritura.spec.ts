import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { PERMISOS_MCP, PERMISOS_MCP_POR_DEFECTO } from './api-keys.service';
import { descargarImagenes, enlaceDeImagen, esDireccionPublica } from './imagenes-seguras';
import { MAX_ESCRITURAS_POR_HORA, MAX_IA_POR_DIA, McpEscriturasService } from './mcp-escrituras.service';
import { HERRAMIENTAS } from './mcp-tools';
import { HERRAMIENTAS_DE_ESCRITURA } from './mcp-write-tools';
import { McpService } from './mcp.service';
import { HERRAMIENTAS_DE_TIENDA_EN_PLATAFORMA } from './platform-tools';

function redisFalso() {
    const datos = new Map<string, string>();
    return {
        datos,
        set: jest.fn(async (k: string, v: string, ...a: any[]) => { if (a.includes('NX') && datos.has(k)) return null; datos.set(k, v); return 'OK'; }),
        get: jest.fn(async (k: string) => datos.get(k) ?? null),
        del: jest.fn(async (k: string) => { datos.delete(k); return 1; }),
        incr: jest.fn(async (k: string) => { const n = Number(datos.get(k) ?? 0) + 1; datos.set(k, String(n)); return n; }),
        expire: jest.fn(async () => 1),
    };
}

function registroFalso() {
    const filas: any[] = [];
    return {
        filas,
        create: jest.fn((x) => x),
        save: jest.fn(async (x) => { const f = { id: `r${filas.length + 1}`, ...x }; filas.push(f); return f; }),
        update: jest.fn(async ({ id }, cambios) => { Object.assign(filas.find((f) => f.id === id), cambios); }),
        find: jest.fn(async () => filas),
    };
}

const acceso: any = { keyId: 'k1', keyName: 'Clave', userId: 'u1', storeId: 's1', role: 'owner', permissions: ['productos.ver', 'productos.editar'] };
const escritura = (extra: any = {}) => ({ herramienta: 'crear_producto', args: { name: 'A' }, resumen: { name: 'A' }, unaSolaVez: true, ...extra });

describe('registro, topes y repeticiones de las escrituras', () => {
    const montar = () => { const redis = redisFalso(); const registro = registroFalso(); return { redis, registro, servicio: new McpEscriturasService(redis as any, registro as any) }; };

    it('anota antes de ejecutar y cierra como hecho', async () => {
        const { servicio, registro } = montar();
        await servicio.ejecutar(acceso, escritura(), async () => { expect(registro.filas[0].estado).toBe('pendiente'); return { id: 'p1' }; });
        expect(registro.filas[0]).toMatchObject({ estado: 'hecho', tool: 'crear_producto', keyId: 'k1', storeId: 's1', resumen: { name: 'A', id: 'p1' } });
    });

    it('la misma creación repetida no crea dos veces, aunque cambie el orden de los datos', async () => {
        const { servicio } = montar();
        const hacer = jest.fn(async () => ({ id: 'p1' }));
        await servicio.ejecutar(acceso, escritura({ args: { a: 1, b: 2 } }), hacer);
        const r: any = await servicio.ejecutar(acceso, escritura({ args: { b: 2, a: 1 } }), hacer);
        expect(hacer).toHaveBeenCalledTimes(1);
        expect(r).toMatchObject({ id: 'p1', repetida: expect.any(String) });
    });

    it('si falla, queda anotado el error y se puede reintentar', async () => {
        const { servicio, registro } = montar();
        await expect(servicio.ejecutar(acceso, escritura(), async () => { throw new BadRequestException('SKU repetido'); })).rejects.toThrow('SKU repetido');
        expect(registro.filas[0]).toMatchObject({ estado: 'error', mensaje: 'SKU repetido' });
        await expect(servicio.ejecutar(acceso, escritura(), async () => ({ id: 'p2' }))).resolves.toEqual({ id: 'p2' });
    });

    it('una edición repetida SÍ se vuelve a aplicar (A, B y otra vez A)', async () => {
        const { servicio } = montar();
        const hacer = jest.fn(async () => ({ id: 'p1' }));
        await servicio.ejecutar(acceso, escritura({ unaSolaVez: false }), hacer);
        await servicio.ejecutar(acceso, escritura({ unaSolaVez: false }), hacer);
        expect(hacer).toHaveBeenCalledTimes(2);
    });

    it('corta al pasar el tope por hora y el de IA por día', async () => {
        const { servicio } = montar();
        const hacer = jest.fn(async () => ({}));
        for (let i = 0; i < MAX_ESCRITURAS_POR_HORA; i++) await servicio.ejecutar(acceso, escritura({ args: { i } }), hacer);
        await expect(servicio.ejecutar(acceso, escritura({ args: { i: 'otra' } }), hacer)).rejects.toThrow(/máximo/);
        expect(hacer).toHaveBeenCalledTimes(MAX_ESCRITURAS_POR_HORA);

        const ia = montar();
        for (let i = 0; i < MAX_IA_POR_DIA; i++) await ia.servicio.ejecutar(acceso, escritura({ usaIa: true, unaSolaVez: false }), hacer);
        await expect(ia.servicio.ejecutar(acceso, escritura({ usaIa: true, unaSolaVez: false }), hacer)).rejects.toThrow(/IA/);
    });

    it('sin Redis o sin registro no se escribe', async () => {
        const hacer = jest.fn(async () => ({}));
        const roto = montar();
        roto.redis.set.mockRejectedValue(new Error('caído'));
        await expect(roto.servicio.ejecutar(acceso, escritura(), hacer)).rejects.toThrow(/no se pueden hacer cambios/);
        const sinRegistro = montar();
        sinRegistro.registro.save.mockRejectedValue(new Error('base caída'));
        await expect(sinRegistro.servicio.ejecutar(acceso, escritura(), hacer)).rejects.toThrow('base caída');
        expect(hacer).not.toHaveBeenCalled();
    });
});

describe('fotos por enlace', () => {
    it.each(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:0a00:0001::1'])(
        '%s no es una dirección de internet', (ip) => expect(esDireccionPublica(ip)).toBe(false));

    it('las direcciones de internet sí', () => {
        expect(esDireccionPublica('8.8.8.8')).toBe(true);
        expect(esDireccionPublica('2606:4700:4700::1111')).toBe(true);
    });

    it.each(['http://ejemplo.com/a.jpg', 'file:///etc/passwd', 'https://localhost/a.jpg', 'https://redis.railway.internal/a', 'https://127.0.0.1/a.jpg', 'https://[::1]/a.jpg', 'https://2130706433/a.jpg', 'https://u:p@ejemplo.com/a.jpg', 'https://ejemplo.com:6379/', 'no es un enlace'])(
        'rechaza %s', (u) => expect(() => enlaceDeImagen(u)).toThrow(BadRequestException));

    it('descarga sin redirecciones ni proxy y solo acepta JPG', async () => {
        const get = jest.spyOn(axios, 'get').mockResolvedValue({ data: Buffer.from('x'), headers: { 'content-type': 'image/jpeg' } } as any);
        await expect(descargarImagenes(['https://ejemplo.com/a.jpg'])).resolves.toHaveLength(1);
        expect(get.mock.calls[0][1]).toMatchObject({ maxRedirects: 0, proxy: false });
        get.mockResolvedValue({ data: Buffer.from('x'), headers: { 'content-type': 'text/html' } } as any);
        await expect(descargarImagenes(['https://ejemplo.com/a.jpg'])).rejects.toThrow(/no es una imagen JPG/);
        get.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:443'));
        await expect(descargarImagenes(['https://ejemplo.com/a.jpg'])).rejects.not.toThrow(/10\.0\.0\.5/);
        get.mockRestore();
    });
});

describe('herramientas de escritura', () => {
    it('todas exigen productos.editar, que no va por defecto, y ninguna está en el MCP de plataforma', () => {
        expect(HERRAMIENTAS_DE_ESCRITURA.map((h) => h.name)).toEqual(['crear_enlace_para_fotos', 'crear_producto', 'crear_producto_con_variantes', 'agregar_variantes', 'editar_producto', 'generar_contenido_ia']);
        for (const h of HERRAMIENTAS_DE_ESCRITURA) {
            expect(h.permiso).toBe('productos.editar');
            expect(h.escribe).toBe(true);
        }
        expect(PERMISOS_MCP).toContain('productos.editar');
        expect(PERMISOS_MCP_POR_DEFECTO).not.toContain('productos.editar');
        const dePlataforma = HERRAMIENTAS_DE_TIENDA_EN_PLATAFORMA.map((h) => h.original);
        expect(dePlataforma).toEqual(HERRAMIENTAS);
        expect(dePlataforma.some((h: any) => h.escribe)).toBe(false);
    });

    async function conectar(permissions: string[], servicios: any) {
        const redis = redisFalso();
        const registro = registroFalso();
        const mcp = new McpService({} as any, servicios.products, {} as any, {} as any, {} as any, {} as any, {} as any, servicios.groups, servicios.upload, new McpEscriturasService(redis as any, registro as any), servicios.fotos ?? ({ yaSubidas: async () => new Set() } as any));
        const [a, b] = InMemoryTransport.createLinkedPair();
        await mcp.crearServidor({ ...acceso, permissions }).connect(a);
        const cliente = new Client({ name: 'test', version: '1' });
        await cliente.connect(b);
        return { cliente, registro };
    }
    const texto = (r: any) => r.content[0].text as string;

    it('una clave de solo lectura no ve ni puede llamar las herramientas de escritura', async () => {
        const create = jest.fn();
        const { cliente } = await conectar(['productos.ver'], { products: { create } });
        const { tools } = await cliente.listTools();
        expect(tools.map((t) => t.name)).toEqual(['listar_productos', 'ver_producto']);
        const r: any = await cliente.callTool({ name: 'editar_producto', arguments: { id: '3f2b1c9e-8a4d-4f6b-9c1e-2d3a4b5c6d7e', name: 'x' } });
        expect(r.isError).toBe(true);
        expect(create).not.toHaveBeenCalled();
    });

    it('no edita un producto que está en un canal', async () => {
        const update = jest.fn();
        const products = { update, estadoParaEditarSinPublicar: jest.fn().mockResolvedValue({ name: 'X', groupId: null, vinculado: true }) };
        const { cliente, registro } = await conectar(['productos.editar'], { products });
        const r = await cliente.callTool({ name: 'editar_producto', arguments: { id: '3f2b1c9e-8a4d-4f6b-9c1e-2d3a4b5c6d7e', name: 'Nuevo' } });
        expect(texto(r)).toMatch(/vinculado a un canal/);
        expect(update).not.toHaveBeenCalled();
        expect(registro.filas[0].estado).toBe('error');
    });

    it('editar ignora precio, stock, SKU y fotos aunque vengan en la petición', async () => {
        const update = jest.fn().mockResolvedValue({ id: 'p', name: 'Nuevo', sku: 'S' });
        const products = { update, estadoParaEditarSinPublicar: jest.fn().mockResolvedValue({ name: 'X', groupId: null, vinculado: false }) };
        const { cliente } = await conectar(['productos.editar'], { products });
        await cliente.callTool({ name: 'editar_producto', arguments: { id: '3f2b1c9e-8a4d-4f6b-9c1e-2d3a4b5c6d7e', name: 'Nuevo', price: 1, stock: 999, sku: 'Z', images: ['https://x.com/a.jpg'] } });
        expect(update.mock.calls[0][1]).toEqual({ name: 'Nuevo' });
    });

    it('la IA solo completa lo vacío', async () => {
        const generateAIContent = jest.fn().mockResolvedValue({ aiTitle: 'T', llenado: ['título'] });
        const products = { generateAIContent, estadoParaEditarSinPublicar: jest.fn().mockResolvedValue({ name: 'X', groupId: null, vinculado: false }) };
        const { cliente } = await conectar(['productos.editar'], { products });
        await cliente.callTool({ name: 'generar_contenido_ia', arguments: { id: '3f2b1c9e-8a4d-4f6b-9c1e-2d3a4b5c6d7e' } });
        expect(generateAIContent.mock.calls[0][2]).toEqual({ soloVacio: true });
    });

    it('crear con variantes no usa la IA y no acepta enlaces internos', async () => {
        const crear = jest.fn();
        const uploadImages = jest.fn();
        const { cliente } = await conectar(['productos.editar'], { products: {}, groups: { crear }, upload: { uploadImages } });
        const r = await cliente.callTool({
            name: 'crear_producto_con_variantes',
            arguments: { name: 'Polo', description: 'Algodón', axes: [{ name: 'Color', values: ['Rojo'] }], variants: [{ values: { Color: 'Rojo' }, images: ['https://127.0.0.1/a.jpg'] }] },
        });
        expect(texto(r)).toMatch(/enlaces https públicos/);
        expect(crear).not.toHaveBeenCalled();
        expect(uploadImages).not.toHaveBeenCalled();
    });
});
