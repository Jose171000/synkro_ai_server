import { SyncService } from './sync.service';

/** Las variantes de un grupo salen en Mercado Libre como una familia: mismo nombre sin color, y el color de cada una. */
const proto: any = SyncService.prototype;
const contexto = { atributosParaMeli: proto.atributosParaMeli };
const payloadDe = (p: any) => proto.buildMeliItemPayload.call(contexto, p, 'MPE1');
const idsDe = (p: any) => Object.fromEntries(contexto.atributosParaMeli(p).map((a: any) => [a.id, a.value_name]));

const grupo = { name: 'Perchero Elegante Multifuncional Kasari Metal Negro Azul', parentSku: 'PERCHERO-METAL', axes: [{ name: 'Color', values: ['Negro', 'Celeste'] }] };
const variante = (sku: string, color: string) => ({
    sku, name: `Perchero Elegante Multifuncional Kasari Metal Negro Azul - ${color}`, aiTitle: `Perchero Elegante Multifuncional Kasari Metal - ${color}`, price: 39.9, stock: 10, images: [{ url: 'https://i/1.jpg' }],
    group: grupo, variantValues: { Color: color },
    aiAttributes: { brand: 'Kasari', mercadolibre_attributes: { COLOR: 'Azul', MAIN_COLOR: 'Negro', MATERIAL: 'Metal' } },
});

describe('familias de Mercado Libre', () => {
    it('todas las variantes llevan el mismo family_name, sin colores', () => {
        const a = payloadDe(variante('OG144', 'Negro'));
        const b = payloadDe(variante('OG146', 'Celeste'));
        expect(a.family_name).toBe('Perchero Elegante Multifuncional Kasari Metal');
        expect(b.family_name).toBe(a.family_name);
    });

    it('cada variante lleva su propio color, su SKU y el modelo del grupo', () => {
        const negro = idsDe(variante('OG144', 'Negro'));
        const celeste = idsDe(variante('OG146', 'Celeste'));
        expect(negro).toMatchObject({ COLOR: 'Negro', MAIN_COLOR: 'Negro', SELLER_SKU: 'OG144', MODEL: 'PERCHERO-METAL', MATERIAL: 'Metal' });
        expect(celeste).toMatchObject({ COLOR: 'Celeste', MAIN_COLOR: 'Celeste', SELLER_SKU: 'OG146', MODEL: 'PERCHERO-METAL' });
    });

    it('un producto sin grupo se publica como siempre', () => {
        const simple = { sku: 'KI-1', name: 'Taza', aiTitle: 'Taza de cerámica azul', price: 10, stock: 3, images: [], group: null, variantValues: null, aiAttributes: { brand: 'X', mercadolibre_attributes: { COLOR: 'Azul' } } };
        expect(payloadDe(simple).family_name).toBe('Taza de cerámica azul');
        expect(idsDe(simple)).toMatchObject({ COLOR: 'Azul', MODEL: 'KI-1', SELLER_SKU: 'KI-1' });
    });
});

describe('Mercado Libre: variantes que salen como publicaciones separadas', () => {
    const duvetGrupo = { name: 'Duvet Hotelero 100% Algodón Casatex con Cierre y Fundas', parentSku: 'UVT-001B', axes: [{ name: 'Tamaño cama', values: ['2 plazas', 'King'] }] };
    const duvet = (sku: string, tam: string) => ({ sku, name: 'Duvet', aiTitle: 'Duvet', price: 350, stock: 10, images: [], group: duvetGrupo, variantValues: { 'Tamaño cama': tam }, aiAttributes: { brand: 'Casatex' } });
    const servicio = (admitidos: any[], falla = false) => {
        const s: any = Object.create(SyncService.prototype);
        s.ejesDeVariacionMeli = jest.fn(async () => { if (falla) throw new Error('ML no responde'); return admitidos; });
        return s;
    };
    const COLOR = [{ id: 'COLOR', label: 'Color' }, { id: 'FABRIC_DESIGN', label: 'Diseño de la tela' }, { id: 'PACKAGE_WIDTH', label: 'Ancho del paquete' }];

    it('si la categoría no admite el eje (tamaño de cama), se detecta como separadas', async () => {
        expect(await (servicio(COLOR) as any).variantesVanSeparadasEnMeli(duvet('F', '2 plazas'), 'MPE444718')).toBe(true);
    });

    it('si la categoría sí admite el eje, siguen como una familia', async () => {
        const conTamano = [...COLOR, { id: 'MATTRESS_SIZE', label: 'Tamaño del colchón' }];
        expect(await (servicio(conTamano) as any).variantesVanSeparadasEnMeli(duvet('F', '2 plazas'), 'MPE1')).toBe(false);
    });

    it('si no se puede saber (ML no responde) o no hay grupo, se publica como siempre', async () => {
        expect(await (servicio([], true) as any).variantesVanSeparadasEnMeli(duvet('F', '2 plazas'), 'MPE1')).toBe(false);
        expect(await (servicio(COLOR) as any).variantesVanSeparadasEnMeli({ sku: 'X', group: null }, 'MPE1')).toBe(false);
    });

    it('separadas: cada publicación lleva su tamaño en el nombre; juntas, el mismo nombre sin tamaño', () => {
        const separado = (p: any) => proto.buildMeliItemPayload.call(contexto, p, 'MPE444718', true).family_name;
        const junto = (p: any) => proto.buildMeliItemPayload.call(contexto, p, 'MPE444718', false).family_name;
        expect(separado(duvet('F', '2 plazas'))).toMatch(/ - 2 plazas$/);
        expect(separado(duvet('K', 'King'))).toMatch(/ - King$/);
        expect(separado(duvet('F', '2 plazas')).length).toBeLessThanOrEqual(60);
        expect(separado(duvet('F', '2 plazas'))).not.toBe(separado(duvet('K', 'King')));
        expect(junto(duvet('F', '2 plazas'))).toBe(junto(duvet('K', 'King')));
    });
});

describe('nombre de una variante en Falabella cuando sale como ficha suelta', () => {
    const servicio: any = Object.create(SyncService.prototype);
    const ficha = (sku: string, color: string, extra: any = {}) => ({
        sku, name: `Perchero Elegante Multifuncional Kasari Metal Negro Azul - ${color}`, aiTitle: `Perchero Elegante Multifuncional Kasari Metal Negr - ${color}`,
        price: 39.9, stock: 5, images: [{ url: 'https://i/1.jpg' }], description: 'Un perchero metálico moderno',
        packageWidth: 18, packageLength: 80, packageHeight: 12, packageWeight: 2.2,
        marketplaceIds: { falabella_category_id: '3169' },
        aiAttributes: { brand: 'Kasari', color: 'Azul', color_basico: 'Negro' },
        group: grupo, variantValues: { Color: color }, ...extra,
    });

    it('se arma desde el nombre del grupo con el color al final, sin palabras partidas ni colores repetidos', () => {
        const negro = servicio.toFalabellaInput(ficha('OG144', 'Negro'));
        const celeste = servicio.toFalabellaInput(ficha('OG146', 'Celeste'));
        expect(negro.input.name).toBe('Perchero Elegante Multifuncional Kasari Metal - Negro');
        expect(celeste.input.name).toBe('Perchero Elegante Multifuncional Kasari Metal - Celeste');
    });

    it('un producto sin grupo conserva su título', () => {
        const simple = servicio.toFalabellaInput(ficha('KI-1', 'x', { group: null, variantValues: null, aiTitle: 'Taza de cerámica azul 350 ml', name: 'Taza' }));
        expect(simple.input.name).toBe('Taza de cerámica azul 350 ml');
    });
});

describe('calzado en Falabella: variantes por talla y color agrupadas por ParentSku', () => {
    const servicio: any = Object.create(SyncService.prototype);
    const campo = (name: string, over: any = {}) => ({ name, feedName: name, label: name, isMandatory: true, inputType: 'dropdown', options: [], ...over });
    const categoria = [
        campo('genero', { options: ['Mujer', 'Hombre'] }),
        campo('color_basico', { options: ['Beige', 'Burdeo', 'Fucsia', 'Negro', 'Multicolor'] }),
        campo('color', { options: ['Beige', 'Burdeos', 'Fucsia', 'Negro'] }),
        campo('talla', { options: ['35', '36', '37', '38', '39'] }),
    ];
    const sandalias = { name: 'Sandalias de cuero', parentSku: 'SAN-DEM', axes: [{ name: 'Color', values: ['Beige', 'Vino', 'Negro', 'Fucsia'] }, { name: 'Talla', values: ['35', '36', '37', '38', '39'] }] };
    const variante = (sku: string, color: string, talla: string, extra: any = {}) => ({
        sku, name: 'Sandalias de cuero floater', aiTitle: 'Sandalias de cuero floater', price: 200, stock: 4, images: [{ url: 'https://i/1.jpg' }],
        description: 'Sandalias de cuero vacuno floater con plantilla EVA', packageWidth: 13, packageLength: 32, packageHeight: 12, packageWeight: 0.85,
        marketplaceIds: { falabella_category_id: '3223' },
        aiAttributes: { brand: 'GENERICO', genero: 'Mujer', color: 'Multicolor', color_basico: 'Multicolor', talla: '38' },
        group: sandalias, variantValues: { Color: color, Talla: talla }, ...extra,
    });

    it('las variantes de un grupo salen con el mismo ParentSku aunque la categoría no tenga campos «…Variant»', () => {
        const a: any = servicio.toFalabellaInput(variante('SAN-DEM-NEG-38', 'Negro', '38'), 'active', categoria);
        const b: any = servicio.toFalabellaInput(variante('SAN-DEM-BEI-35', 'Beige', '35'), 'active', categoria);
        expect(a.input.parentSku).toBe('SAN-DEM');
        expect(b.input.parentSku).toBe('SAN-DEM');
        expect(a.input.sellerSku).toBe('SAN-DEM-NEG-38');
        expect(a.input.extraAttributes).toMatchObject({ color: 'Negro', color_basico: 'Negro', talla: '38' });
        expect(b.input.extraAttributes).toMatchObject({ color: 'Beige', talla: '35' });
    });

    it('todas las variantes agrupadas comparten el nombre del grupo, sin color ni talla; una ficha suelta conserva su título', () => {
        const a: any = servicio.toFalabellaInput(variante('SAN-DEM-NEG-38', 'Negro', '38'), 'active', categoria);
        const b: any = servicio.toFalabellaInput(variante('SAN-DEM-BEI-35', 'Beige', '35'), 'active', categoria);
        expect(a.input.name).toBe('Sandalias de cuero');
        expect(b.input.name).toBe(a.input.name);
        const completos = { brand: 'G', genero: 'Mujer', color: 'Negro', color_basico: 'Negro', talla: '38' };
        const suelta: any = servicio.toFalabellaInput(variante('X-1', 'Negro', '38', { group: null, variantValues: null, aiAttributes: completos }), 'active', categoria);
        expect(suelta.input.name).toBe('Sandalias de cuero floater');
        // Con campos «…Variant» también: Falabella guarda el nombre por familia, y la variación (color, talla) se muestra aparte en cada ficha.
        const conVariant: any = servicio.toFalabellaInput(variante('X-4', 'Negro', '38'), 'active', [campo('ColorVariant', { isMandatory: false, options: [] })]);
        const conVariant2: any = servicio.toFalabellaInput(variante('X-5', 'Beige', '35'), 'active', [campo('ColorVariant', { isMandatory: false, options: [] })]);
        expect(conVariant.input.name).toBe('Sandalias de cuero');
        expect(conVariant2.input.name).toBe(conVariant.input.name);
    });

    it('«Vino» no se rechaza: se manda como Burdeo (color básico) y Burdeos (color)', () => {
        const r: any = servicio.toFalabellaInput(variante('SAN-DEM-VIN-36', 'Vino', '36'), 'active', categoria);
        expect('input' in r).toBe(true);
        expect(r.input.extraAttributes).toMatchObject({ color_basico: 'Burdeo', color: 'Burdeos', talla: '36' });
    });

    it('una ficha suelta de calzado, una categoría sin talla y color, o una que ya dijo que ParentSku no aplica, salen como antes', () => {
        const completos = { brand: 'G', genero: 'Mujer', color: 'Negro', color_basico: 'Negro', talla: '38' };
        const suelta: any = servicio.toFalabellaInput(variante('X-1', 'Negro', '38', { group: null, variantValues: null, aiAttributes: completos }), 'active', categoria);
        expect(suelta.input.sellerSku).toBe('X-1');
        expect(suelta.input.parentSku).toBeUndefined();
        const sinVariacion: any = servicio.toFalabellaInput(variante('X-2', 'Negro', '38'), 'active', [campo('genero', { options: ['Mujer'] })]);
        expect(sinVariacion.input.parentSku).toBeUndefined();
        const noAplica: any = servicio.toFalabellaInput(variante('X-3', 'Negro', '38', { aiAttributes: { ...completos, _noAplica: ['ParentSku'] } }), 'active', categoria);
        expect(noAplica.input.sellerSku).toBe('X-3');
        expect(noAplica.input.parentSku).toBeUndefined();
    });

    it('la consulta de categoría dice que el calzado admite variantes (por talla y color); una sin variación, no', async () => {
        const s: any = Object.create(SyncService.prototype);
        s.resolveConnection = jest.fn(async () => ({ id: 'c1' }));
        s.credentialsOf = jest.fn(() => ({}));
        s.falabellaApi = { getCategoryAttributes: jest.fn(async (_c: any, id: string) => (id === '3223' ? categoria : id === '9' ? [campo('ColorVariant')] : [campo('genero')])) };
        const scope: any = { storeId: 's' };
        expect(await s.falabellaCategoryVariants(scope, '3223')).toMatchObject({ admiteVariantes: true, porTallaYColor: true, publicacion: expect.stringContaining('talla y color') });
        expect(await s.falabellaCategoryVariants(scope, '9')).toMatchObject({ admiteVariantes: true, porTallaYColor: false });
        expect(await s.falabellaCategoryVariants(scope, '1')).toMatchObject({ admiteVariantes: false, publicacion: expect.stringContaining('no admite variantes') });
    });

    it('una categoría con campos «…Variant» sigue agrupando como siempre, con o sin talla y color', () => {
        const conVariant = [campo('ColorVariant', { isMandatory: false, options: [] })];
        const r: any = servicio.toFalabellaInput(variante('X-4', 'Negro', '38'), 'active', conVariant);
        expect(r.input.parentSku).toBe('SAN-DEM');
    });
});

describe('publicar un grupo de variantes sin IA', () => {
    const construir = (familia: any[], enqueue: jest.Mock) => {
        const s: any = Object.create(SyncService.prototype);
        s.familiaDe = jest.fn(async () => familia);
        s.enqueuePublish = enqueue;
        return s as SyncService;
    };
    const scope: any = { userId: 'u', storeId: 's' };

    it('manda la orden de cada variante y no falla si algunas ya estaban publicadas', async () => {
        const enqueue = jest.fn(async (_s: any, id: string) => { if (id === 'b') throw new Error('Este producto ya está publicado'); return { message: 'ok' }; });
        const r = await construir([{ id: 'a' }, { id: 'b' }, { id: 'c' }], enqueue).enqueuePublishFamilia(scope, 'a', ['mercadolibre'], { mercadolibre: 'c1' });
        expect(enqueue).toHaveBeenCalledTimes(3);
        expect(r.message).toContain('2 de 3 variantes');
    });

    it('si ninguna se pudo encolar, devuelve el error', async () => {
        const enqueue = jest.fn(async () => { throw new Error('Este producto ya está publicado'); });
        await expect(construir([{ id: 'a' }, { id: 'b' }], enqueue).enqueuePublishFamilia(scope, 'a', ['mercadolibre'])).rejects.toThrow(/ya está publicado/);
    });

    it('un producto sin variantes se publica como siempre', async () => {
        const enqueue = jest.fn(async () => ({ message: 'ok' }));
        await construir([{ id: 'a' }], enqueue).enqueuePublishFamilia(scope, 'a', ['falabella']);
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledWith(scope, 'a', ['falabella'], {});
    });
});
