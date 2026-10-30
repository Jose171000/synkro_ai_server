import { aplicarContenidoImportado, contenidoDeFichaFalabella, contenidoDeItemMeli, resumenDeContenido } from './contenido-importado';

/**
 * Lo que el canal ya tenía de un producto se guarda como referencia y rellena SOLO lo vacío: lo que ya tiene valor
 * (un dato real que alguien revisó, o lo que el canal mostraba) nunca se pisa.
 */
const ficha = (over: any = {}): any => ({
    SellerSku: 'SKU-1', Name: 'Proteína Whey 5 lb', Brand: 'MUTANT',
    Description: '<div><h2>Proteína</h2><p>Para recuperación</p></div>',
    ProductData: { Sabor: 'Vainilla', Material: 'Polvo', Vacio: '', Objeto: { a: 1 }, Peso: 2.5 },
    ...over,
});

describe('lo que trae la ficha de Falabella', () => {
    it('toma nombre, descripción, marca y los atributos con valor (texto o número), sin los vacíos ni los anidados', () => {
        const c = contenidoDeFichaFalabella(ficha());
        expect(c).toMatchObject({ name: 'Proteína Whey 5 lb', brand: 'MUTANT' });
        expect(c.description).toContain('<h2>Proteína</h2>');
        expect(c.atributos).toEqual({ Sabor: 'Vainilla', Material: 'Polvo', Peso: '2.5' });
    });

    it('una ficha sin esos campos no falla', () => {
        const c = contenidoDeFichaFalabella({ SellerSku: 'X' } as any);
        expect(c).toEqual({ name: '', description: '', brand: '', atributos: {} });
        expect(resumenDeContenido(c)).toEqual({ descripcion: false, marca: false, atributos: 0 });
    });
});

describe('lo que trae una publicación de Mercado Libre', () => {
    const item = { title: 'Proteína Whey', attributes: [{ id: 'BRAND', value_name: 'Mutant' }, { id: 'FLAVOR', value_name: 'Vainilla' }, { id: 'SELLER_SKU', value_name: 'S-1' }, { id: 'VACIO', value_name: '' }] };

    it('toma la marca y los atributos con valor (sin el SKU) y la descripción que se le pase', () => {
        const c = contenidoDeItemMeli(item, 'Proteína para recuperación');
        expect(c).toMatchObject({ name: 'Proteína Whey', brand: 'Mutant', description: 'Proteína para recuperación' });
        expect(c.atributos).toEqual({ BRAND: 'Mutant', FLAVOR: 'Vainilla' });
    });

    it('sin descripción pedida queda vacía', () => {
        expect(contenidoDeItemMeli(item).description).toBe('');
    });
});

describe('guardar lo que el canal tenía sin pisar nada', () => {
    const ahora = new Date('2026-10-30T12:00:00Z');

    it('un producto vacío recibe la ficha HTML, la marca y los atributos, y queda la copia de referencia', () => {
        const p: any = { aiDescription: null, aiAttributes: {} };
        expect(aplicarContenidoImportado(p, 'falabella', contenidoDeFichaFalabella(ficha()), ahora)).toBe(true);
        expect(p.aiAttributes.descriptionHtml).toContain('<h2>Proteína</h2>');
        expect(p.aiAttributes.brand).toBe('MUTANT');
        expect(p.aiAttributes).toMatchObject({ Sabor: 'Vainilla', Material: 'Polvo' });
        expect(p.aiDescription).toBeNull();
        expect(p.aiAttributes._importado.falabella).toMatchObject({ name: 'Proteína Whey 5 lb', brand: 'MUTANT', importedAt: '2026-10-30T12:00:00.000Z' });
        expect(p.aiAttributes._importado.falabella.attributes).toEqual({ Sabor: 'Vainilla', Material: 'Polvo', Peso: '2.5' });
    });

    it('lo que el producto ya tenía no se toca: marca, HTML y atributos (aunque se escriban con otras mayúsculas o espacios)', () => {
        const p: any = { aiDescription: null, aiAttributes: { brand: 'Marca propia', descriptionHtml: '<div>mía</div>', sabor: 'Chocolate' } };
        aplicarContenidoImportado(p, 'falabella', contenidoDeFichaFalabella(ficha()), ahora);
        expect(p.aiAttributes.brand).toBe('Marca propia');
        expect(p.aiAttributes.descriptionHtml).toBe('<div>mía</div>');
        expect(p.aiAttributes.sabor).toBe('Chocolate');
        expect(p.aiAttributes.Sabor).toBeUndefined();
        expect(p.aiAttributes.Material).toBe('Polvo');
    });

    it('si el canal no trae nada que importar no se guarda nada, ni una copia vacía', () => {
        const p: any = { aiDescription: null, aiAttributes: {} };
        expect(aplicarContenidoImportado(p, 'falabella', contenidoDeFichaFalabella({ SellerSku: 'X', Name: 'Solo nombre' } as any), ahora)).toBe(false);
        expect(p.aiAttributes).toEqual({});
    });

    it('un atributo presente pero vacío sí se rellena', () => {
        const p: any = { aiAttributes: { Sabor: '  ', brand: '' } };
        aplicarContenidoImportado(p, 'falabella', contenidoDeFichaFalabella(ficha()), ahora);
        expect(p.aiAttributes.Sabor).toBe('Vainilla');
        expect(p.aiAttributes.brand).toBe('MUTANT');
    });

    it('una descripción en texto plano va al campo de texto y solo si estaba vacío', () => {
        const vacio: any = { aiDescription: null, aiAttributes: {} };
        aplicarContenidoImportado(vacio, 'falabella', contenidoDeFichaFalabella(ficha({ Description: 'Solo texto plano.' })), ahora);
        expect(vacio.aiDescription).toBe('Solo texto plano.');
        expect(vacio.aiAttributes.descriptionHtml).toBeUndefined();

        const lleno: any = { aiDescription: 'La mía', aiAttributes: {} };
        aplicarContenidoImportado(lleno, 'falabella', contenidoDeFichaFalabella(ficha({ Description: 'Solo texto plano.' })), ahora);
        expect(lleno.aiDescription).toBe('La mía');
    });

    it('la copia de referencia se guarda una sola vez: importar de nuevo no la reemplaza', () => {
        const p: any = { aiAttributes: {} };
        aplicarContenidoImportado(p, 'falabella', contenidoDeFichaFalabella(ficha()), ahora);
        const otraVez = aplicarContenidoImportado(p, 'falabella', contenidoDeFichaFalabella(ficha({ Name: 'Otro nombre', Description: '<p>otra</p>' })), new Date('2027-01-01'));
        expect(otraVez).toBe(false);
        expect(p.aiAttributes._importado.falabella.name).toBe('Proteína Whey 5 lb');
        expect(p.aiAttributes.descriptionHtml).toContain('Para recuperación');
    });

    it('un producto con referencia de un canal igual recibe la del otro canal', () => {
        const p: any = { aiAttributes: {} };
        aplicarContenidoImportado(p, 'falabella', contenidoDeFichaFalabella(ficha()), ahora);
        const hecho = aplicarContenidoImportado(p, 'mercadolibre', contenidoDeItemMeli({ title: 'X', attributes: [{ id: 'COLOR', value_name: 'Negro' }] }, 'Texto de ML'), ahora);
        expect(hecho).toBe(true);
        expect(Object.keys(p.aiAttributes._importado).sort()).toEqual(['falabella', 'mercadolibre']);
        expect(p.aiDescription).toBe('Texto de ML');
    });

    it('Mercado Libre: sus atributos van a mercadolibre_attributes por id y no pisan los que ya tenía', () => {
        const p: any = { aiDescription: null, aiAttributes: { mercadolibre_attributes: { BRAND: 'Mi marca', COLOR: '' } } };
        aplicarContenidoImportado(p, 'mercadolibre', contenidoDeItemMeli({ title: 'X', attributes: [{ id: 'BRAND', value_name: 'Mutant' }, { id: 'COLOR', value_name: 'Negro' }, { id: 'FLAVOR', value_name: 'Vainilla' }] }, null), ahora);
        expect(p.aiAttributes.mercadolibre_attributes).toEqual({ BRAND: 'Mi marca', COLOR: 'Negro', FLAVOR: 'Vainilla' });
        expect(p.aiAttributes.brand).toBe('Mutant');
    });
});
