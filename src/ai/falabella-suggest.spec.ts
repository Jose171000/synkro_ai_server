import { FalabellaAutoPrepService } from './falabella-auto-prep.service';

const def = (name: string, over: any = {}) => ({ name, feedName: name.toUpperCase(), label: name, description: `Ayuda de ${name}`, isMandatory: false, inputType: 'textField', options: [], ...over });

function construir(producto: any, familia?: any[]) {
    const sync: any = {
        findScopedProduct: jest.fn(async () => producto),
        familiaDe: jest.fn(async () => familia ?? [producto]),
        resolveConnection: jest.fn(async () => ({ id: 'c1' })),
        credentialsOf: jest.fn(() => ({ userId: 'x', apiKey: 'k' })),
        buscarAtributo: jest.fn((a: any, n: string) => a[n]),
    };
    const falabella: any = {
        getCategoryAttributes: jest.fn(async () => [
            def('material', { isMandatory: true, options: ['Madera', 'Plástico'] }),
            def('nombre_producto_en_ingles'),
            def('detalle_de_la_condicion'),
            def('condiciones_de_la_garantia'),
            def('brand'),
            def('color'),
        ]),
    };
    const ai: any = {
        completarAtributos: jest.fn(async () => ({
            values: { material: 'Madera', nombre_producto_en_ingles: 'Montessori learning tower', detalle_de_la_condicion: 'Producto nuevo' },
            estimated: [],
        })),
    };
    const service = new FalabellaAutoPrepService(sync, falabella, ai, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { service, ai };
}

const producto = () => ({
    id: 'p1', sku: 'MK-TOR-004', name: 'Torre de aprendizaje Montessori', aiTitle: 'Torre de aprendizaje Montessori 4 en 1',
    description: 'Torre de madera de pino, color azul https://x.com/a.gif', aiDescription: 'desc',
    packageWidth: 45, packageLength: 40, packageHeight: 90, packageWeight: 9,
    aiAttributes: { brand: 'GENERICO', color: 'Azul', vision: { productType: 'torre de aprendizaje' } },
});

describe('sugerir los atributos de una categoría de Falabella', () => {
    it('devuelve lo que ya tiene el producto más lo que la IA saca de todo lo que se sabe, sin guardar nada', async () => {
        const { service, ai } = construir(producto());
        const r = await service.sugerirAtributos({ userId: 'u', storeId: 's' }, 'p1', '956');

        // lo cubierto por la plataforma (marca) no se pide; lo que ya tenía el producto (color) no se vuelve a pedir
        const pedidos = ai.completarAtributos.mock.calls[0][2].map((a: any) => a.name);
        expect(pedidos).toEqual(['material', 'nombre_producto_en_ingles', 'detalle_de_la_condicion', 'condiciones_de_la_garantia']);

        expect(r.values).toMatchObject({ color: 'Azul', material: 'Madera', nombre_producto_en_ingles: 'Montessori learning tower', detalle_de_la_condicion: 'Producto nuevo' });
        // garantía: la IA no la pudo deducir y queda vacía, sin inventar
        expect(r.values.condiciones_de_la_garantia).toBeUndefined();
        expect(r).toMatchObject({ filled: 3, total: 5 });
    });

    it('le pasa a la IA todo el contexto: texto del cliente sin enlaces y el texto ya guardado, fotos, medidas y SKU', async () => {
        const { service, ai } = construir(producto());
        await service.sugerirAtributos({ userId: 'u', storeId: 's' }, 'p1', '956');

        const contexto = ai.completarAtributos.mock.calls[0][4];
        expect(contexto).toMatchObject({ textoCliente: 'Torre de madera de pino, color azul\n\ndesc', sku: 'MK-TOR-004', medidas: '45 x 40 x 90 cm, 9 kg' });
        expect(contexto.vision).toMatchObject({ productType: 'torre de aprendizaje' });
    });

    it('en un producto con variantes la IA también recibe todos los ejes y sus valores', async () => {
        const base = producto();
        const grupo = { name: 'Torre Montessori', axes: [{ name: 'Color', values: ['Azul', 'Rosado'] }, { name: 'Talla', values: ['S', 'M'] }] };
        const { service, ai } = construir(base, [{ ...base, group: grupo }, { ...base, id: 'p2', group: grupo }]);
        await service.sugerirAtributos({ userId: 'u', storeId: 's' }, 'p1', '956');

        const descripcion = ai.completarAtributos.mock.calls[0][1] as string;
        expect(descripcion).toContain('Color: Azul, Rosado');
        expect(descripcion).toContain('Talla: S, M');
    });

    it('un producto sin variantes no recibe ejes', async () => {
        const { service, ai } = construir(producto());
        await service.sugerirAtributos({ userId: 'u', storeId: 's' }, 'p1', '956');
        expect(ai.completarAtributos.mock.calls[0][1] as string).not.toContain('Opciones disponibles');
    });
});
