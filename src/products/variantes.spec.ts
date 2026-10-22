process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { asignarSkus, claveDeCombinacion, combinaciones, etiquetaDe, normalizarEjes, valoresDeVariante } from './variantes';
import { ProductGroupsService } from './product-groups.service';
import { ProductsService } from './products.service';
import { normalizarDeteccion } from '../ai/product-vision.service';

describe('ejes y combinaciones de variantes', () => {
    it('limpia los ejes: sin repetidos (ni por mayúsculas o tildes), sin vacíos', () => {
        const ejes = normalizarEjes([
            { name: ' Color ', values: ['Rojo', 'rojo', ' Azul ', ''] },
            { name: 'Talla', values: ['M', 'L'] },
        ]);
        expect(ejes).toEqual([{ name: 'Color', values: ['Rojo', 'Azul'] }, { name: 'Talla', values: ['M', 'L'] }]);
    });

    it('rechaza ejes inválidos: ninguno, repetido, sin valores o más de 3', () => {
        expect(() => normalizarEjes([])).toThrow(BadRequestException);
        expect(() => normalizarEjes([{ name: 'Color', values: ['Rojo'] }, { name: 'color', values: ['Azul'] }])).toThrow(/repetido/);
        expect(() => normalizarEjes([{ name: 'Color', values: [] }])).toThrow(/al menos un valor/);
        expect(() => normalizarEjes([1, 2, 3, 4].map((n) => ({ name: `E${n}`, values: ['a'] })))).toThrow(/hasta 3 ejes/);
    });

    it('arma todas las combinaciones, con etiqueta y clave estables', () => {
        const ejes = normalizarEjes([{ name: 'Color', values: ['Rojo', 'Azul'] }, { name: 'Talla', values: ['M', 'L'] }]);
        const c = combinaciones(ejes);
        expect(c).toHaveLength(4);
        expect(etiquetaDe(c[0], ejes)).toBe('Rojo · M');
        expect(claveDeCombinacion({ Color: 'ROJO', Talla: ' m ' }, ejes)).toBe(claveDeCombinacion({ Color: 'Rojo', Talla: 'M' }, ejes));
    });

    it('una variante usa la escritura oficial del eje y rechaza valores que el eje no tiene', () => {
        const ejes = normalizarEjes([{ name: 'Color', values: ['Rojo'] }, { name: 'Talla', values: ['M'] }]);
        expect(valoresDeVariante({ color: 'rojo', TALLA: 'm' }, ejes)).toEqual({ Color: 'Rojo', Talla: 'M' });
        expect(() => valoresDeVariante({ Color: 'Verde', Talla: 'M' }, ejes)).toThrow(/no está entre los valores/);
        expect(() => valoresDeVariante({ Color: 'Rojo' }, ejes)).toThrow(/Falta un valor válido/);
    });
});

describe('SKU de las variantes', () => {
    const ejes = normalizarEjes([{ name: 'Color', values: ['Rojo', 'Rosa'] }, { name: 'Talla', values: ['M'] }]);

    it('se generan con el código del grupo y los valores', () => {
        const skus = asignarSkus('MK-1', [{ valores: { Color: 'Rojo', Talla: 'M' } }, { valores: { Color: 'Rosa', Talla: 'M' } }], ejes, new Set());
        expect(skus).toEqual(['MK-1-ROJO-M', 'MK-1-ROSA-M']);
    });

    it('si el SKU ya está ocupado se añade -2, -3… y el escrito a mano se respeta', () => {
        const skus = asignarSkus('MK-1', [{ valores: { Color: 'Rojo', Talla: 'M' } }, { valores: { Color: 'Rosa', Talla: 'M' }, sku: 'MI-SKU' }], ejes, new Set(['mk-1-rojo-m']));
        expect(skus).toEqual(['MK-1-ROJO-M-2', 'MI-SKU']);
    });

    it('un SKU escrito que ya existe o que se repite en el lote es un error', () => {
        const v = [{ valores: { Color: 'Rojo', Talla: 'M' }, sku: 'IGUAL' }, { valores: { Color: 'Rosa', Talla: 'M' }, sku: 'igual' }];
        expect(() => asignarSkus('MK-1', v, ejes, new Set())).toThrow(/ya está en uso/);
        expect(() => asignarSkus('MK-1', [v[0]], ejes, new Set(['igual']))).toThrow(/ya está en uso/);
    });
});

/** Base de datos en memoria: solo lo que usa ProductGroupsService. */
function construir(opciones: { productos?: any[]; ocupados?: string[]; falla23505?: boolean; ia?: any } = {}) {
    const guardados: any[] = [];
    const productos: any[] = opciones.productos ?? [];
    const grupos: any[] = [];
    let n = 0;
    const manager: any = {
        create: (_c: any, x: any) => ({ ...x }),
        save: jest.fn(async (e: any) => {
            if (opciones.falla23505) throw Object.assign(new Error('dup'), { code: '23505' });
            if (!e.id) e.id = `id${++n}`;
            guardados.push(e);
            if ('parentSku' in e) grupos.push(e);
            else productos.push(e);
            return e;
        }),
        update: jest.fn(async (_c: any, id: string, datos: any) => { Object.assign([...productos, ...grupos].find((p) => p.id === id) ?? {}, datos); }),
    };
    const productRepo: any = {
        findOne: jest.fn(async ({ where }: any) => productos.find((p) => p.id === where.id) ?? null),
        find: jest.fn(async ({ where }: any) => productos.filter((p) => p.group?.id === where.group.id)),
    };
    const groupRepo: any = { findOne: jest.fn(async ({ where }: any) => grupos.find((g) => g.id === where.id) ?? null), update: jest.fn(async (id: string, datos: any) => { Object.assign(grupos.find((g) => g.id === id) ?? {}, datos); }) };
    const dataSource: any = { transaction: async (fn: any) => fn(manager) };
    const ocupados = new Set((opciones.ocupados ?? []).map((s) => s.toLowerCase()));
    const products: any = {
        skusExistentes: jest.fn(async (_a: any, skus: string[]) => new Set(skus.map((s) => s.toLowerCase()).filter((s) => ocupados.has(s)))),
    };
    productRepo.save = jest.fn(async (p: any) => p);
    const ai: any = opciones.ia ?? { generateProductContent: jest.fn(async () => ({})) };
    products.applyAiContent = jest.fn((molde: any) => {
        molde.aiTitle = 'Polera de algodón estampada con diseño de personajes';
        molde.aiDescription = 'Descripción de la IA';
        molde.aiAttributes = { brand: 'GENERICO' };
        molde.marketplaceIds = { falabella_category_id: '123' };
        molde.packageWidth = 30;
    });
    const vision: any = { detectarVariantes: jest.fn() };
    return { service: new ProductGroupsService(productRepo, groupRepo, dataSource, products as ProductsService, ai, vision, { siguientes: jest.fn(async () => ['KI-0013']) } as any), manager, guardados, productos, grupos, ai, productRepo, vision, groupRepo };
}

const ambito = { userId: 'u1', storeId: 't1' };
const entrada = () => ({
    parentSku: 'MK-1', name: 'Polera Kasari', description: 'Polera estampada',
    axes: [{ name: 'Color', values: ['Rojo', 'Azul'] }, { name: 'Talla', values: ['M', 'L'] }],
    variants: [
        { values: { Color: 'Rojo', Talla: 'M' }, price: 49.9, stock: 10, images: ['https://i/1.jpg'] },
        { values: { Color: 'Azul', Talla: 'L' }, price: 54.9, stock: 6, sku: 'AZ-L' },
    ],
});

describe('crear un producto con variantes', () => {
    it('crea el grupo y una variante por combinación, en la tienda, con SKU generados', async () => {
        const { service, productos, grupos } = construir();
        const g = await service.crear(entrada(), ambito);
        expect(grupos).toHaveLength(1);
        expect(grupos[0]).toMatchObject({ parentSku: 'MK-1', name: 'Polera Kasari', store: { id: 't1' } });
        expect(productos.map((p) => p.sku)).toEqual(['MK-1-ROJO-M', 'AZ-L']);
        expect(productos[0]).toMatchObject({ name: 'Polera Kasari - Rojo · M', price: 49.9, stock: 10, variantValues: { Color: 'Rojo', Talla: 'M' }, store: { id: 't1' } });
        expect(productos[0].images).toHaveLength(1);
        expect(g.id).toBeTruthy();
    });

    it('sin código de grupo, se genera con el formato de la tienda', async () => {
        const { service, grupos, productos } = construir();
        const e: any = entrada();
        delete e.parentSku;
        await service.crear(e, ambito);
        expect(grupos[0].parentSku).toBe('KI-0013');
        expect(productos[0].sku).toBe('KI-0013-ROJO-M');
    });

    it('rechaza un código de grupo que ya es el SKU de otro producto de la tienda', async () => {
        const { service } = construir({ ocupados: ['MK-1'] });
        await expect(service.crear(entrada(), ambito)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rechaza una combinación repetida y un valor que el eje no tiene', async () => {
        const { service } = construir();
        const repetida = entrada();
        repetida.variants[1] = { values: { Color: 'rojo', Talla: 'm' } } as any;
        await expect(service.crear(repetida, ambito)).rejects.toThrow(/repetida/);
        const invalida = entrada();
        invalida.variants[0].values.Color = 'Verde';
        await expect(service.crear(invalida, ambito)).rejects.toThrow(/no está entre los valores/);
    });

    it('si dos cargas a la vez chocan, la base lo rechaza y sale un mensaje claro', async () => {
        const { service } = construir({ falla23505: true });
        await expect(service.crear(entrada(), ambito)).rejects.toThrow(/ya está en uso en esta tienda/);
    });

    it('un SKU escrito que ya existe en la tienda se rechaza', async () => {
        const { service } = construir({ ocupados: ['AZ-L'] });
        await expect(service.crear(entrada(), ambito)).rejects.toThrow(/ya está en uso en esta tienda/);
    });
});

describe('agregar variantes a un producto que ya existe', () => {
    const simple = () => ({ id: 'p0', sku: 'MK-TOR-004', name: 'Torre Montessori', description: 'Torre de madera', category: 'Hogar', store: { id: 't1' }, owner: { id: 'u1' }, group: null, variantValues: null });

    it('lo convierte en grupo: conserva su SKU (código del grupo) y se vuelve la primera variante', async () => {
        const base = simple();
        const { service, productos, grupos } = construir({ productos: [base] });
        await service.agregarVariantes('p0', {
            axes: [{ name: 'Color', values: ['Natural', 'Blanco'] }],
            thisVariant: { Color: 'Natural' },
            variants: [{ values: { Color: 'Blanco' }, price: 480, stock: 4 }],
        }, ambito);
        expect(grupos[0]).toMatchObject({ parentSku: 'MK-TOR-004', name: 'Torre Montessori' });
        expect(base).toMatchObject({ group: { id: grupos[0].id }, variantValues: { Color: 'Natural' } });
        const nueva = productos.find((p) => p.sku === 'MK-TOR-004-BLANCO');
        expect(nueva).toMatchObject({ description: 'Torre de madera', category: 'Hogar', stock: 4, variantValues: { Color: 'Blanco' } });
    });

    it('al convertir hay que decir qué variante es el producto actual', async () => {
        const { service } = construir({ productos: [simple()] });
        await expect(service.agregarVariantes('p0', { axes: [{ name: 'Color', values: ['Natural', 'Blanco'] }], variants: [{ values: { Color: 'Blanco' } }] }, ambito))
            .rejects.toThrow(/qué variante es el producto/);
    });

    it('no permite repetir la combinación del producto actual', async () => {
        const { service } = construir({ productos: [simple()] });
        await expect(service.agregarVariantes('p0', { axes: [{ name: 'Color', values: ['Natural', 'Blanco'] }], thisVariant: { Color: 'Natural' }, variants: [{ values: { Color: 'natural' } }] }, ambito))
            .rejects.toBeInstanceOf(ConflictException);
    });

    it('en un grupo existente suma variantes y añade valores nuevos a un eje, pero no ejes nuevos', async () => {
        const base = simple();
        const { service, productos, grupos } = construir({ productos: [base] });
        await service.agregarVariantes('p0', { axes: [{ name: 'Color', values: ['Natural', 'Blanco'] }], thisVariant: { Color: 'Natural' }, variants: [{ values: { Color: 'Blanco' } }] }, ambito);
        expect(grupos[0].axes[0].values).toEqual(['Natural', 'Blanco']);

        // ya es un grupo: un valor nuevo de un eje existente se incorpora solo
        await service.agregarVariantes('p0', { variants: [{ values: { Color: 'Negro' } }] }, ambito);
        expect(productos.some((p) => p.variantValues?.Color === 'Negro')).toBe(true);
        expect(grupos[0].axes[0].values).toEqual(['Natural', 'Blanco', 'Negro']);
        await expect(service.agregarVariantes('p0', { variants: [{ values: { Color: 'Rojo', Talla: 'M' } }] }, ambito))
            .rejects.toThrow(/no se pueden añadir ejes nuevos/);
    });

    it('un producto de otra tienda no se puede convertir', async () => {
        const ajeno: any = { ...simple(), store: { id: 'otra' } };
        const { service } = construir({ productos: [ajeno] });
        await expect(service.agregarVariantes('p0', { axes: [{ name: 'Color', values: ['A', 'B'] }], thisVariant: { Color: 'A' }, variants: [{ values: { Color: 'B' } }] }, ambito))
            .rejects.toThrow(/no encontrado/);
    });
});

describe('generar con IA el contenido de un grupo', () => {
    const conIa = () => ({ ...entrada(), generateWithAi: true, targetMarketplaces: ['falabella'] });

    it('genera una sola vez y reparte el contenido entre las variantes, cada una con su título y sus valores', async () => {
        const { service, ai, productRepo, productos } = construir();
        // el simulador devuelve las variantes creadas cuando se las pide por grupo
        productRepo.find.mockImplementation(async () => productos.filter((p) => p.variantValues));
        const g = await service.crear(conIa(), ambito);
        expect(ai.generateProductContent).toHaveBeenCalledTimes(1);
        expect(ai.generateProductContent.mock.calls[0][0]).toMatchObject({ imageUrls: ['https://i/1.jpg'], targetMarketplaces: ['falabella'], userId: 'u1' });
        expect(g.ia).toEqual({ ok: true });
        const v = productos.find((p) => p.sku === 'MK-1-ROJO-M');
        expect(v.aiTitle.endsWith(' - Rojo · M')).toBe(true);
        expect(v.aiTitle.length).toBeLessThanOrEqual(60);
        expect(v).toMatchObject({ aiDescription: 'Descripción de la IA', marketplaceIds: { falabella_category_id: '123' }, packageWidth: 30, status: 'synced' });
        expect(v.aiAttributes).toMatchObject({ brand: 'GENERICO', Color: 'Rojo', Talla: 'M' });
    });

    it('sin nombre ni descripción escritos, el nombre del grupo y de las variantes lo pone la IA', async () => {
        const { service, productos, grupos, productRepo } = construir();
        productRepo.find.mockImplementation(async () => productos.filter((p) => p.variantValues));
        const e: any = { ...conIa(), name: undefined, description: undefined };
        await service.crear(e, ambito);
        expect(grupos[0].name).toBe('Polera de algodón estampada con diseño de personajes');
        const v = productos.find((p) => p.sku === 'MK-1-ROJO-M');
        expect(v.name).toBe('Polera de algodón estampada con diseño de personajes - Rojo · M');
        expect(v.description).toBe('Descripción de la IA');
    });

    it('si la IA falla, las variantes quedan creadas y se avisa', async () => {
        const ia: any = { generateProductContent: jest.fn(async () => { throw new Error('IA caída'); }) };
        const { service, productos, productRepo } = construir({ ia });
        productRepo.find.mockImplementation(async () => productos.filter((p) => p.variantValues));
        const g = await service.crear(conIa(), ambito);
        expect(g.ia).toEqual({ ok: false, motivo: 'IA caída' });
        expect(productos.filter((p) => p.variantValues)).toHaveLength(2);
    });
});

describe('detector de variantes', () => {
    it('una sola foto que dice «disponible en azul y negro» recomienda variantes de color, sin foto por color', () => {
        const r = normalizarDeteccion({
            nivel: 'alta',
            ejes: [{ nombre: 'Color', valores: ['Azul', 'Negro'], evidencia: 'La foto 1 dice «disponible en azul y negro»' }],
            fotos: [{ foto: 1, valores: null }],
            resumen: 'Disponible en dos colores',
        }, 1);
        expect(r.recomendar).toBe(true);
        expect(r.ejes).toEqual([{ name: 'Color', values: ['Azul', 'Negro'], evidence: 'La foto 1 dice «disponible en azul y negro»' }]);
        expect(r.fotos).toEqual([{ indice: 1, valores: null }]);
    });

    it('no recomienda si no hay evidencia: nivel bajo, o un eje con un solo valor', () => {
        expect(normalizarDeteccion({ nivel: 'baja', ejes: [{ nombre: 'Color', valores: ['Rojo', 'Azul'] }] }).recomendar).toBe(false);
        const unico = normalizarDeteccion({ nivel: 'alta', ejes: [{ nombre: 'Color', valores: ['Rojo'] }] });
        expect(unico.recomendar).toBe(false);
        expect(unico.nivel).toBe('baja');
        expect(unico.ejes).toEqual([]);
        expect(normalizarDeteccion(null).recomendar).toBe(false);
    });

    it('asigna fotos a valores solo si el valor existe en el eje, y limpia repetidos y excesos', () => {
        const r = normalizarDeteccion({
            nivel: 'media',
            ejes: [{ nombre: 'Color', valores: ['Rojo', 'rojo', 'Azul'] }, { nombre: 'Talla', valores: ['M', 'L'] }, { nombre: 'Color', valores: ['X'] }],
            fotos: [{ foto: 1, valores: { color: 'rojo' } }, { foto: 2, valores: { Color: 'Verde' } }, { foto: 9, valores: { Color: 'Azul' } }],
        }, 3);
        expect(r.ejes.map((e) => e.values)).toEqual([['Rojo', 'Azul'], ['M', 'L']]);
        expect(r.fotos).toEqual([{ indice: 1, valores: { Color: 'Rojo' } }, { indice: 2, valores: null }]);
    });
});
