import { RipleyPublicacionService } from './ripley-publicacion.service';

const SCOPE = { userId: 'u', storeId: 's' };

const CAMPOS_LONCHERAS = [
    { name: 'tipo_product', label: 'Tipo de producto', required: true, isVariant: false, listCode: 'tipo_product' },
    { name: 'color_80', label: 'Color', required: true, isVariant: true, listCode: 'color_80', options: ['Beige', 'Marrón', 'Negro'] },
    { name: 'escolar', label: 'Escolar', required: true, isVariant: false },
];
const CAMPOS_SANDALIAS = [
    { name: 'tipo_product', label: 'Tipo de producto', required: true, isVariant: false },
    { name: 'color_80', label: 'Color', required: true, isVariant: true, options: ['Beige', 'Marrón', 'Negro'] },
    { name: 'talla_calzado_faceta', label: 'Talla calzado', required: true, isVariant: true, options: ['35', '36', '37'] },
];

const producto = (over: any = {}) => ({
    id: 'p1', sku: 'BP000007', price: '99.00', stock: 4, name: 'Lonchera', description: 'x', aiDescription: 'x',
    packageLength: 26, packageWidth: 17, packageHeight: 26, packageWeight: 0.4,
    images: [{ url: 'https://x.com/a.jpg', order: 0 }],
    marketplaceIds: { ripley_category_id: 'R141100000000' },
    aiAttributes: {
        descriptionHtml: '<p>Ficha</p>',
        ripley: { name: 'lonchera marrón térmica', shortDescription: 'Lonchera térmica.', brand: 'GENÉRICO' },
        ripley_attributes: { tipo_product: 'Loncheras', color_80: 'Marrón', escolar: 'No' },
    },
    ...over,
});

function construir(opts: { familia?: any[]; campos?: any[]; path?: string; marcaValida?: boolean } = {}) {
    const p = producto();
    const sync: any = {
        findScopedProduct: jest.fn(async () => p),
        familiaDe: jest.fn(async () => opts.familia ?? [p]),
        resolveConnection: jest.fn(async () => ({ id: 'c1' })),
    };
    const ecommerce: any = { authOf: jest.fn(() => ({ site: 'x', token: 'k' })) };
    const ripley: any = {
        importarProductosYOfertas: jest.fn(async () => ({ importId: 77, productImportId: 88 })),
        estadoDeImportacion: jest.fn(async () => ({ status: 'COMPLETE', lines_read: 1, lines_in_success: 1, lines_in_error: 0 })),
        estadoDeProductos: jest.fn(async () => ({ import_status: 'COMPLETE', transform_lines_read: 1, transform_lines_in_success: 1, transform_lines_in_error: 0 })),
        reporteDeErrores: jest.fn(async () => ['fila 1: error']),
    };
    const catalogo: any = {
        campos: jest.fn(async () => ({ id: 'R141100000000', path: opts.path ?? 'MALETERÍA, BOLSOS Y CARTERAS › LONCHERAS', campos: opts.campos ?? CAMPOS_LONCHERAS })),
        listaCompleta: jest.fn(async () => ['Beige', 'Marrón', 'Negro']),
    };
    const marcas: any = { revisar: jest.fn(async (m: string) => ({ valor: m, valida: opts.marcaValida ?? true, canonica: (opts.marcaValida ?? true) ? m : null, sugerencias: [] })) };
    const service = new RipleyPublicacionService(sync, ecommerce, ripley, catalogo, marcas);
    return { service, sync, ripley, catalogo, ecommerce, p };
}

const apagar = () => { delete process.env.RIPLEY_PUBLISH_ENABLED; delete process.env.RIPLEY_PUBLISH_SKUS; };
afterEach(apagar);

describe('vista previa de la publicación en Ripley (no envía nada)', () => {
    it('un producto sin variantes: arma su fila con la ficha HTML general, sin errores', async () => {
        const { service, ripley } = construir();
        const v = await service.vistaPrevia(SCOPE, 'p1');

        expect(v.publicaComo).toBe('sola');
        expect(v.puedeEnviar).toBe(true);
        expect(v.categoria).toEqual({ id: 'R141100000000', ruta: 'MALETERÍA, BOLSOS Y CARTERAS › LONCHERAS' });
        expect(v.csv).toContain('MALETERÍA, BOLSOS Y CARTERAS/LONCHERAS');
        expect(v.csv).toContain('LONCHERA MARRÓN TÉRMICA');
        expect(v.csv).toContain('<p>Ficha</p>');
        expect(v.csv).toContain('BP000007;BP000007;SHOP_SKU');
        expect(ripley.importarProductosYOfertas).not.toHaveBeenCalled();
    });

    it('sin categoría de Ripley no hay nada que enviar y lo dice', async () => {
        const { service, sync } = construir();
        sync.findScopedProduct.mockResolvedValue(producto({ marketplaceIds: {} }));
        const v = await service.vistaPrevia(SCOPE, 'p1');
        expect(v.puedeEnviar).toBe(false);
        expect(v.errores[0]).toContain('no tiene categoría de Ripley');
    });

    it('lo que falta (descripción corta, marca fuera del catálogo) sale como error por producto', async () => {
        const { service, sync } = construir({ marcaValida: false });
        sync.findScopedProduct.mockResolvedValue(producto({ aiAttributes: { ripley: { name: 'lonchera', brand: 'TIGO' }, ripley_attributes: { tipo_product: 'Loncheras', color_80: 'Marrón', escolar: 'No' } } }));
        const v = await service.vistaPrevia(SCOPE, 'p1');
        expect(v.puedeEnviar).toBe(false);
        expect(v.productos[0].errores.join(' ')).toContain('Falta la descripción corta');
        expect(v.productos[0].errores.join(' ')).toContain('«TIGO» no está en el catálogo aprobado de Ripley');
    });

    it('sin interruptor y sin SKU permitido lo informa, para que se vea antes de intentar enviar', async () => {
        const { service } = construir();
        const v = await service.vistaPrevia(SCOPE, 'p1');
        expect(v.envioEncendido).toBe(false);
        expect(v.skusNoPermitidos).toEqual(['BP000007']);
    });
});

describe('productos con variantes', () => {
    const grupo = { parentSku: 'SAN-DEM', name: 'Sandalias', axes: [{ name: 'Color', values: ['Beige', 'negro'] }, { name: 'Talla', values: ['35', '36'] }] };
    const variante = (sku: string, color: string, talla: string) => producto({
        id: sku, sku, group: grupo, variantValues: { Color: color, Talla: talla },
        marketplaceIds: { ripley_category_id: 'R250600000000' },
        aiAttributes: { descriptionHtml: '<p>f</p>', ripley: { name: 'sandalias de cuero', shortDescription: 'Sandalias.', brand: 'GENÉRICO' }, ripley_attributes: { tipo_product: 'Sandalias' } },
    });
    const familia = [variante('SAN-1', 'Beige', '35'), variante('SAN-2', 'negro', '36')];

    it('si la categoría admite sus ejes van en UNA publicación (mismo variant_id) y cada una con su color y talla exactos de Ripley', async () => {
        const { service } = construir({ familia, campos: CAMPOS_SANDALIAS, path: 'CALZADO › SANDALIAS' });
        const v = await service.vistaPrevia(SCOPE, 'p1', { alGrupo: true });

        expect(v.publicaComo).toBe('una');
        expect(v.puedeEnviar).toBe(true);
        const filas = v.csv.trim().split('\r\n');
        const cab = filas[0].split(';');
        const col = (fila: string, nombre: string) => fila.split(';')[cab.indexOf(nombre)];
        expect(col(filas[1], 'variant_id')).toBe('SAN-DEM');
        expect(col(filas[2], 'variant_id')).toBe('SAN-DEM');
        expect(col(filas[1], 'color_80')).toBe('Beige');
        expect(col(filas[2], 'color_80')).toBe('Negro'); // «negro» → «Negro» de la lista de Ripley
        expect(col(filas[2], 'talla_calzado_faceta')).toBe('36');
    });

    it('si la categoría NO admite variantes se envían como productos separados, con aviso y con la combinación en el nombre', async () => {
        const { service } = construir({ familia, campos: CAMPOS_LONCHERAS, path: 'MALETERÍA › LONCHERAS' });
        const v = await service.vistaPrevia(SCOPE, 'p1', { alGrupo: true });

        expect(v.publicaComo).toBe('separadas');
        expect(v.avisosDeVariantes[0]).toContain('separados en Ripley');
        const filas = v.csv.trim().split('\r\n');
        expect(filas[1].split(';')[filas[0].split(';').indexOf('variant_id')]).toBe('');
        expect(v.productos[0].nombre).toContain('BEIGE');
        expect(v.productos[0].nombre).not.toBe(v.productos[1].nombre);
    });

    it('un color o talla que Ripley no tiene deja el dato obligatorio sin llenar y se marca como error', async () => {
        const { service } = construir({ familia: [variante('SAN-1', 'Fucsia', '35')], campos: CAMPOS_SANDALIAS, path: 'CALZADO › SANDALIAS' });
        // con un solo miembro no es grupo: se prueba con dos para que cuente como familia
        const dos = [variante('SAN-1', 'Fucsia', '35'), variante('SAN-2', 'Beige', '36')];
        const { service: s2 } = construir({ familia: dos, campos: CAMPOS_SANDALIAS, path: 'CALZADO › SANDALIAS' });
        const v = await s2.vistaPrevia(SCOPE, 'p1', { alGrupo: true });
        expect(v.puedeEnviar).toBe(false);
        expect(v.productos[0].errores.join(' ')).toContain('Falta el dato obligatorio «Color»');
        expect(v.productos[1].errores).toEqual([]);
        void service;
    });
});

describe('enviar a Ripley: los seguros', () => {
    const encender = (skus = 'BP000007') => { process.env.RIPLEY_PUBLISH_ENABLED = 'true'; process.env.RIPLEY_PUBLISH_SKUS = skus; };

    it('sin confirmación expresa no se envía', async () => {
        encender();
        const { service, ripley } = construir();
        await expect(service.publicar(SCOPE, 'p1', {})).rejects.toThrow('confirmación expresa');
        expect(ripley.importarProductosYOfertas).not.toHaveBeenCalled();
    });

    it('con el interruptor apagado no se envía, aunque se confirme', async () => {
        process.env.RIPLEY_PUBLISH_SKUS = 'BP000007';
        const { service, ripley } = construir();
        await expect(service.publicar(SCOPE, 'p1', { confirmar: true })).rejects.toThrow('apagada');
        expect(ripley.importarProductosYOfertas).not.toHaveBeenCalled();
    });

    it('un SKU que no está en la lista permitida no se envía', async () => {
        encender('OTRO-SKU');
        const { service, ripley } = construir();
        await expect(service.publicar(SCOPE, 'p1', { confirmar: true })).rejects.toThrow('RIPLEY_PUBLISH_SKUS');
        expect(ripley.importarProductosYOfertas).not.toHaveBeenCalled();
    });

    it('con errores en los datos no se envía y se dice cuáles', async () => {
        encender();
        const { service, sync, ripley } = construir();
        sync.findScopedProduct.mockResolvedValue(producto({ price: '0' }));
        await expect(service.publicar(SCOPE, 'p1', { confirmar: true })).rejects.toThrow('BP000007: Falta un precio mayor que cero');
        expect(ripley.importarProductosYOfertas).not.toHaveBeenCalled();
    });

    it('con todo en regla y confirmado envía UNA vez el CSV validado y devuelve los números de seguimiento', async () => {
        encender();
        const { service, ripley } = construir();
        const r = await service.publicar(SCOPE, 'p1', { confirmar: true });
        expect(ripley.importarProductosYOfertas).toHaveBeenCalledTimes(1);
        expect((ripley.importarProductosYOfertas.mock.calls[0] as any[])[1]).toContain('BP000007');
        expect(r).toMatchObject({ importId: 77, productImportId: 88, enviados: ['BP000007'], publicaComo: 'sola' });
    });
});

describe('seguimiento de lo enviado', () => {
    it('listo cuando ofertas y productos terminaron sin errores', async () => {
        const { service } = construir();
        expect(await service.estado(SCOPE, '77', '88')).toMatchObject({ resumen: 'listo', errores: { ofertas: [], productos: [] } });
    });

    it('con errores trae el reporte de Ripley', async () => {
        const { service, ripley } = construir();
        ripley.estadoDeProductos.mockResolvedValue({ import_status: 'COMPLETE', transform_lines_in_error: 1, has_transformation_error_report: true });
        const r = await service.estado(SCOPE, '77', '88');
        expect(r.resumen).toBe('con-errores');
        expect(r.errores.productos).toEqual(['fila 1: error']);
    });

    it('en curso mientras alguna importación no haya terminado', async () => {
        const { service, ripley } = construir();
        ripley.estadoDeImportacion.mockResolvedValue({ status: 'RUNNING' });
        expect((await service.estado(SCOPE, '77', '88')).resumen).toBe('en-curso');
    });
});
