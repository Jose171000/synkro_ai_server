import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ForbiddenException } from '@nestjs/common';
import { HERRAMIENTAS } from './mcp-tools';
import { HERRAMIENTAS_DE_TIENDA_EN_PLATAFORMA, HERRAMIENTAS_PLATAFORMA, resumenDeCliente } from './platform-tools';
import { McpPlataformaService, herramientasDeTiendaPermitidas, herramientasPlataformaPermitidas } from './mcp-plataforma.service';
import { McpService } from './mcp.service';

/** Tabla fijada a propósito: cambiar el permiso de una herramienta, o agregar una sin permiso, hace fallar esta prueba. */
const PERMISO_POR_HERRAMIENTA: Record<string, string> = {
    listar_clientes: 'clientes.ver',
    ver_cliente: 'clientes.ver',
    listar_tiendas: 'clientes.ver',
    solicitudes_de_registro: 'clientes.ver',
    cartera_agencia: 'finanzas.ver',
    ver_tienda_en_cartera: 'finanzas.ver',
    resumen_financiero: 'finanzas.ver',
    cobros_del_periodo: 'finanzas.ver',
    tendencia_de_cobros: 'finanzas.ver',
    estado_del_sistema: 'sistema.ver',
    listar_claves_mcp: 'sistema.ver',
};

describe('herramientas del MCP de plataforma', () => {
    it('cada herramienta exige el permiso fijado', () => {
        expect(Object.fromEntries(HERRAMIENTAS_PLATAFORMA.map((h) => [h.name, h.permiso]))).toEqual(PERMISO_POR_HERRAMIENTA);
    });

    it('ninguna herramienta modifica nada: ni el nombre ni el código usan verbos de escritura', () => {
        const escritura = /^(crear|editar|borrar|eliminar|aprobar|rechazar|registrar|cambiar|resetear|limpiar|revocar|publicar|actualizar)/;
        for (const h of [...HERRAMIENTAS_PLATAFORMA, ...HERRAMIENTAS_DE_TIENDA_EN_PLATAFORMA]) {
            expect(h.name.replace(/^tienda_/, '')).not.toMatch(escritura);
        }
    });

    it('las herramientas de tienda se ofrecen todas, con tiendaId obligatorio y los mismos permisos de tienda', () => {
        expect(HERRAMIENTAS_DE_TIENDA_EN_PLATAFORMA.map((h) => h.name)).toEqual(HERRAMIENTAS.map((h) => `tienda_${h.name}`));
        for (const h of HERRAMIENTAS_DE_TIENDA_EN_PLATAFORMA) {
            expect(h.input).toHaveProperty('tiendaId');
            expect(h.permisoDeTienda).toBe(h.original.permiso);
        }
    });

    it('cada clave solo ve lo que sus permisos dejan', () => {
        const nombres = (permissions: any[]) => [...herramientasPlataformaPermitidas({ permissions }), ...herramientasDeTiendaPermitidas({ permissions })].map((h) => h.name);
        expect(nombres(['sistema.ver'])).toEqual(['estado_del_sistema', 'listar_claves_mcp']);
        const clientes = nombres(['clientes.ver']);
        expect(clientes).toEqual(expect.arrayContaining(['listar_clientes', 'listar_tiendas', 'tienda_listar_ventas', 'tienda_reporte_ventas']));
        expect(clientes).not.toContain('cartera_agencia');
        expect(clientes).not.toContain('estado_del_sistema');
        expect(nombres(['clientes.ver', 'finanzas.ver'])).toEqual(expect.arrayContaining(['cartera_agencia', 'resumen_financiero', 'cobros_del_periodo']));
    });

    it('el resumen de cliente no filtra contraseña, teléfono ni enlaces, y el dinero solo con finanzas', () => {
        const crudo = {
            id: 'c1', email: 'a@x.com', name: 'Ana', lastName: 'Ruiz', nameCompany: 'Joli', password: 'HASH', cellPhone: '999', allowedSections: ['x'],
            profile: { businessName: 'Joli SAC', ruc: '20', sheetCsvUrl: 'https://hoja-secreta', reportEmbedUrl: 'https://otra', monthlyFee: 700, billingModel: 'fijo', commissionRate: 0.02, notes: 'privado' },
            stats: { products: 3, publishedListings: 2, connectedMarketplaces: ['falabella'], totalPaid: 5000, lastPaymentAt: '2026-11-01' },
        };
        const sin = JSON.stringify(resumenDeCliente(crudo, false));
        const con = JSON.stringify(resumenDeCliente(crudo, true));
        for (const v of [sin, con]) expect(v).not.toMatch(/HASH|999|hoja-secreta|otra|privado|allowedSections/);
        expect(sin).not.toMatch(/monthlyFee|totalPaid|commissionRate/);
        expect(con).toMatch(/monthlyFee/);
        expect(con).toMatch(/totalPaid/);
    });
});

const UUID = '11111111-1111-4111-8111-111111111111';

async function conectar(permissions: string[], mocks: any = {}) {
    const requireAccess = mocks.requireAccess ?? jest.fn().mockResolvedValue({ role: 'owner' });
    const deTienda = new McpService({} as any, mocks.products, mocks.orders, mocks.overview, mocks.dashboard, mocks.reports, mocks.changes, {} as any, {} as any, {} as any);
    const svc = new McpPlataformaService(
        mocks.keys ?? {}, { requireAccess } as any, deTienda, mocks.admin ?? {}, mocks.insights ?? {}, mocks.billing ?? {}, mocks.signups ?? {}, mocks.storeRepo ?? {}, mocks.redis ?? {},
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await svc.crearServidor({ keyId: 'k', keyName: 'Agencia', userId: 'admin1', permissions: permissions as any }).connect(a);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(b);
    return { c, requireAccess };
}
const texto = (r: any) => r.content[0].text as string;

describe('servidor MCP de plataforma de punta a punta (en memoria)', () => {
    it('anuncia solo lo permitido y todo de solo lectura', async () => {
        const { c } = await conectar(['sistema.ver']);
        const { tools } = await c.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(['estado_del_sistema', 'listar_claves_mcp']);
        expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    });

    it('listar_clientes oculta lo sensible y filtra por texto', async () => {
        const getClients = jest.fn().mockResolvedValue([
            { id: 'c1', email: 'ana@x.com', name: 'Ana', lastName: 'Ruiz', nameCompany: 'Joli Joli', password: 'HASH', role: 'user', teamOnly: false, profile: { monthlyFee: 700 }, stats: { products: 3, totalPaid: 9000 } },
            { id: 'c2', email: 'otro@x.com', name: 'Otro', lastName: 'Y', nameCompany: 'Chumpi', role: 'user', teamOnly: false },
            { id: 'c3', email: 'equipo@x.com', name: 'Eq', lastName: 'Z', role: 'user', teamOnly: true },
        ]);
        const { c } = await conectar(['clientes.ver'], { admin: { getClients } });
        const t = texto(await c.callTool({ name: 'listar_clientes', arguments: { search: 'joli' } }));
        expect(t).toContain('ana@x.com');
        expect(t).not.toMatch(/HASH|otro@x|equipo@x|monthlyFee|totalPaid/);
        // Con finanzas sí viaja el dinero.
        const f = await conectar(['clientes.ver', 'finanzas.ver'], { admin: { getClients } });
        expect(texto(await f.c.callTool({ name: 'listar_clientes', arguments: {} }))).toContain('totalPaid');
    });

    it('ver_cliente: los pagos solo con finanzas', async () => {
        const getClientDetail = jest.fn().mockResolvedValue({ id: UUID, email: 'a@x.com', name: 'A', lastName: 'B', password: 'HASH', payments: [{ id: 'p1', paidAt: '2026-11-01', amount: '700', currency: 'PEN', type: 'recurrente', concept: 'Cuota' }] });
        const sin = await conectar(['clientes.ver'], { admin: { getClientDetail } });
        expect(texto(await sin.c.callTool({ name: 'ver_cliente', arguments: { id: UUID } }))).not.toMatch(/payments|HASH/);
        const con = await conectar(['clientes.ver', 'finanzas.ver'], { admin: { getClientDetail } });
        expect(texto(await con.c.callTool({ name: 'ver_cliente', arguments: { id: UUID } }))).toContain('"amount": 700');
    });

    it('solicitudes_de_registro no incluye el teléfono', async () => {
        const list = jest.fn().mockResolvedValue({ conteo: { pendientes: 1, rechazadas: 0 }, solicitudes: [{ id: 's', email: 'n@x.com', telefono: '999888777', ruc: '20' }] });
        const { c } = await conectar(['clientes.ver'], { signups: { list } });
        const t = texto(await c.callTool({ name: 'solicitudes_de_registro', arguments: {} }));
        expect(t).toContain('n@x.com');
        expect(t).not.toContain('999888777');
        expect(list).toHaveBeenCalledWith('pending');
    });

    it('listar_tiendas no expone el enlace público ni datos de plan', async () => {
        const find = jest.fn().mockResolvedValue([{ id: UUID, name: 'Joli Joli', createdAt: new Date(), owner: { id: 'u', email: 'jj@x.com' }, publicToken: 'TOKEN-SECRETO' }]);
        const { c } = await conectar(['clientes.ver'], { storeRepo: { find } });
        const t = texto(await c.callTool({ name: 'listar_tiendas', arguments: {} }));
        expect(t).toContain('Joli Joli');
        expect(t).not.toContain('TOKEN-SECRETO');
        expect(find.mock.calls[0][0].select).toBeDefined();
    });

    it('tienda_listar_ventas usa la tienda elegida y el acceso de la CLAVE, no el de dueño: sin contacto de compradores', async () => {
        const list = jest.fn().mockResolvedValue({ total: 0, items: [] });
        const { c, requireAccess } = await conectar(['clientes.ver'], { orders: { list } });
        await c.callTool({ name: 'tienda_listar_ventas', arguments: { tiendaId: UUID, status: 'pendiente' } });
        expect(requireAccess).toHaveBeenCalledWith('admin1', UUID, 'viewer');
        const [storeId, acceso, query] = list.mock.calls[0];
        expect(storeId).toBe(UUID);
        expect(acceso.role).toBe('owner');
        expect(acceso.permissions).not.toContain('ventas.contacto');
        expect(acceso.permissions).not.toContain('costos.ver');
        expect(query).toMatchObject({ status: 'pendiente' });
        expect(query).not.toHaveProperty('tiendaId');
    });

    it('con finanzas, el reporte de una tienda sí incluye costos', async () => {
        const getSalesReport = jest.fn().mockResolvedValue({});
        const { c } = await conectar(['clientes.ver', 'finanzas.ver'], { reports: { getSalesReport } });
        await c.callTool({ name: 'tienda_reporte_ventas', arguments: { tiendaId: UUID } });
        expect(getSalesReport.mock.calls[0][5]).toBe(true);
    });

    it('una tienda que no existe da el error de la app, y un id mal escrito ni llega al servicio', async () => {
        const requireAccess = jest.fn().mockRejectedValue(new ForbiddenException('No tienes acceso a esta tienda.'));
        const list = jest.fn();
        const { c } = await conectar(['clientes.ver'], { requireAccess, orders: { list } });
        const r: any = await c.callTool({ name: 'tienda_listar_ventas', arguments: { tiendaId: UUID } });
        expect(r.isError).toBe(true);
        expect(texto(r)).toBe('No tienes acceso a esta tienda.');
        const mal: any = await c.callTool({ name: 'tienda_listar_ventas', arguments: { tiendaId: 'no-es-uuid' } }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
        expect(mal.isError).toBe(true);
        expect(list).not.toHaveBeenCalled();
    });

    it('cobros_del_periodo valida el formato del periodo', async () => {
        const getPeriod = jest.fn().mockResolvedValue({ rows: [] });
        const { c } = await conectar(['clientes.ver', 'finanzas.ver'], { billing: { getPeriod } });
        await c.callTool({ name: 'cobros_del_periodo', arguments: { periodo: '2026-10' } });
        expect(getPeriod).toHaveBeenCalledWith('2026-10');
        const mal: any = await c.callTool({ name: 'cobros_del_periodo', arguments: { periodo: '10/2026' } }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
        expect(mal.isError).toBe(true);
    });

    it('listar_claves_mcp pasa el superadmin que llama, y un error inesperado sale genérico', async () => {
        const listarTodas = jest.fn().mockResolvedValue([{ id: 'k', name: 'x' }]);
        const { c } = await conectar(['sistema.ver'], { keys: { listarTodas } });
        await c.callTool({ name: 'listar_claves_mcp', arguments: { estado: 'activa' } });
        expect(listarTodas).toHaveBeenCalledWith('admin1', { kind: undefined, estado: 'activa' });

        const boom = await conectar(['sistema.ver'], { redis: { info: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 10.0.0.9:6379')) } });
        const r: any = await boom.c.callTool({ name: 'estado_del_sistema', arguments: {} });
        expect(r.isError).toBe(true);
        expect(texto(r)).not.toContain('10.0.0.9');
    });
});
