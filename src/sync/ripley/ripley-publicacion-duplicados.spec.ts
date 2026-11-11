import { RipleyPublicacionService } from './ripley-publicacion.service';

const SCOPE = { userId: 'u', storeId: 's' };

const CAMPOS = [
    { name: 'tipo_product', label: 'Tipo de producto', required: true, isVariant: false },
    { name: 'color_80', label: 'Color', required: true, isVariant: true, options: ['Marrón'] },
];

function construir() {
    const p: any = {
        id: 'p1', sku: 'BP000007', price: '99.00', stock: 4, name: 'Lonchera', description: 'x', aiDescription: 'x',
        packageLength: 26, packageWidth: 17, packageHeight: 26, packageWeight: 0.4,
        images: [{ url: 'https://x.com/a.jpg', order: 0 }],
        marketplaceIds: { ripley_category_id: 'R141100000000' },
        aiAttributes: {
            descriptionHtml: '<p>Ficha</p>',
            ripley: { name: 'LONCHERA', shortDescription: 'Lonchera.', brand: 'GENÉRICO' },
            ripley_attributes: { tipo_product: 'Loncheras', color_80: 'Marrón' },
        },
    };
    const sync: any = {
        findScopedProduct: jest.fn(async () => p),
        familiaDe: jest.fn(async () => [p]),
        resolveConnection: jest.fn(async () => ({ id: 'c1' })),
        saveProduct: jest.fn(async (x: any) => x),
    };
    const ecommerce: any = { authOf: jest.fn(() => ({ site: 'x', token: 'k' })) };
    const ripley: any = {
        importarProductosYOfertas: jest.fn(async () => ({ importId: 77, productImportId: 88 })),
        estadoDeImportacion: jest.fn(async () => ({ status: 'COMPLETE', lines_read: 1, lines_in_success: 1, lines_in_error: 0 })),
        estadoDeProductos: jest.fn(async () => ({ import_status: 'COMPLETE', transform_lines_read: 1, transform_lines_in_success: 1, transform_lines_in_error: 0 })),
        reporteDeErrores: jest.fn(async () => ['Línea 2: error']),
    };
    const catalogo: any = {
        campos: jest.fn(async () => ({ id: 'R141100000000', path: 'MALETERÍA › LONCHERAS', campos: CAMPOS })),
        listaCompleta: jest.fn(async () => ['Marrón']),
    };
    const marcas: any = { revisar: jest.fn(async (m: string) => ({ valor: m, valida: true, canonica: m, sugerencias: [] })) };
    const service = new RipleyPublicacionService(sync, ecommerce, ripley, catalogo, marcas);
    return { service, sync, ripley, p };
}

const encender = () => { process.env.RIPLEY_PUBLISH_ENABLED = 'true'; process.env.RIPLEY_PUBLISH_SKUS = 'BP000007'; };
afterEach(() => { delete process.env.RIPLEY_PUBLISH_ENABLED; delete process.env.RIPLEY_PUBLISH_SKUS; });

describe('no reenviar un producto ya enviado (evita duplicados)', () => {
    it('al enviar, el producto queda anotado con su importación', async () => {
        encender();
        const { service, p, sync } = construir();
        await service.publicar(SCOPE, 'p1', { confirmar: true });
        expect(p.aiAttributes.ripley_envio).toMatchObject({ importId: 77, productImportId: 88 });
        expect(sync.saveProduct).toHaveBeenCalled();
    });

    it('si el envío anterior sigue pendiente en Ripley, NO se reenvía: avisa y no llama a Ripley', async () => {
        encender();
        const { service, p, ripley } = construir();
        p.aiAttributes.ripley_envio = { importId: 77, productImportId: 88, enviadoEn: new Date().toISOString() };
        ripley.estadoDeImportacion.mockResolvedValue({ status: 'WAITING_SYNCHRONIZATION_PRODUCT' });
        ripley.estadoDeProductos.mockResolvedValue({ import_status: 'SENT' });

        const v = await service.vistaPrevia(SCOPE, 'p1');
        expect(v.bloqueo).toMatchObject({ situacion: 'pendiente', importId: 77 });
        await expect(service.publicar(SCOPE, 'p1', { confirmar: true })).rejects.toThrow('pendiente de aprobación');
        expect(ripley.importarProductosYOfertas).not.toHaveBeenCalled();
    });

    it('si ya se procesó sin errores tampoco se reenvía (lo duplicaría)', async () => {
        encender();
        const { service, p, ripley } = construir();
        p.aiAttributes.ripley_envio = { importId: 77, productImportId: 88, enviadoEn: '2026-11-01T00:00:00.000Z' };
        await expect(service.publicar(SCOPE, 'p1', { confirmar: true })).rejects.toThrow('duplicarlo');
        expect(ripley.importarProductosYOfertas).not.toHaveBeenCalled();
    });

    it('si Ripley lo rechazó con errores, sí se puede corregir y reenviar', async () => {
        encender();
        const { service, p, ripley } = construir();
        p.aiAttributes.ripley_envio = { importId: 77, productImportId: 88, enviadoEn: new Date().toISOString() };
        ripley.estadoDeProductos.mockResolvedValue({ import_status: 'COMPLETE', transform_lines_in_error: 1, has_transformation_error_report: true });
        const v = await service.vistaPrevia(SCOPE, 'p1');
        expect(v.bloqueo).toBeNull();
        await service.publicar(SCOPE, 'p1', { confirmar: true });
        expect(ripley.importarProductosYOfertas).toHaveBeenCalledTimes(1);
    });

    it('si Ripley no responde, un envío reciente se considera pendiente y no se reenvía', async () => {
        encender();
        const { service, p, ripley } = construir();
        p.aiAttributes.ripley_envio = { importId: 77, productImportId: 88, enviadoEn: new Date().toISOString() };
        ripley.estadoDeImportacion.mockRejectedValue(new Error('caído'));
        await expect(service.publicar(SCOPE, 'p1', { confirmar: true })).rejects.toThrow('no se pudo comprobar');
        expect(ripley.importarProductosYOfertas).not.toHaveBeenCalled();
    });

    it('un doble clic (dos envíos a la vez del mismo producto) manda UNA sola vez', async () => {
        encender();
        const { service, ripley } = construir();
        ripley.importarProductosYOfertas.mockImplementation(() => new Promise((ok) => setTimeout(() => ok({ importId: 77, productImportId: 88 }), 30)));
        const resultados = await Promise.allSettled([service.publicar(SCOPE, 'p1', { confirmar: true }), service.publicar(SCOPE, 'p1', { confirmar: true })]);
        expect(resultados.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(ripley.importarProductosYOfertas).toHaveBeenCalledTimes(1);
        const rechazado = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(String(rechazado.reason?.message)).toContain('ya se está enviando');
    });

    it('si el envío falla, el cerrojo se suelta y se puede intentar de nuevo', async () => {
        encender();
        const { service, ripley } = construir();
        ripley.importarProductosYOfertas.mockRejectedValueOnce(new Error('Ripley caído'));
        await expect(service.publicar(SCOPE, 'p1', { confirmar: true })).rejects.toThrow('Ripley caído');
        await expect(service.publicar(SCOPE, 'p1', { confirmar: true })).resolves.toMatchObject({ importId: 77 });
    });

    it('registrar un envío anterior (hecho antes de este control) lo deja anotado y bloqueado', async () => {
        encender();
        const { service, p, ripley } = construir();
        ripley.estadoDeImportacion.mockResolvedValue({ status: 'WAITING_SYNCHRONIZATION_PRODUCT' });
        ripley.estadoDeProductos.mockResolvedValue({ import_status: 'SENT' });
        const r = await service.registrarEnvio(SCOPE, 'p1', { importId: '6896687', productImportId: '1307683' });
        expect(r.registrados).toEqual(['BP000007']);
        expect(p.aiAttributes.ripley_envio).toMatchObject({ importId: '6896687', productImportId: '1307683' });
        await expect(service.publicar(SCOPE, 'p1', { confirmar: true })).rejects.toThrow('pendiente de aprobación');
    });

    it('no se puede registrar una importación que Ripley no conoce', async () => {
        const { service, ripley, p } = construir();
        ripley.estadoDeImportacion.mockRejectedValue(new Error('Ripley no encontró lo pedido'));
        await expect(service.registrarEnvio(SCOPE, 'p1', { importId: '1' })).rejects.toThrow('no encontró');
        expect(p.aiAttributes.ripley_envio).toBeUndefined();
    });
});
