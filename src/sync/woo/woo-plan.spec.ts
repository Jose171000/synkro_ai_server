import { descripcionParaWoo, fotosHttps, pesoYMedidas, planificarWoo, PlanInvalido, preciosDe, ProductoParaWoo } from './woo-plan';

const producto = (sobre: Partial<ProductoParaWoo> = {}): ProductoParaWoo => ({
    id: 'p1', sku: 'SKU-1', name: 'Sábana', price: 100, stock: 5, images: [{ url: 'https://c.com/1.jpg' }], ...sobre,
});

describe('woo-plan · producto simple', () => {
    it('crea un borrador simple con precio, stock, SKU y fotos', () => {
        const plan = planificarWoo([producto({ aiTitle: 'Sábana Premium', category: 'Hogar', subCategory: 'Cama' })]);
        expect(plan.tipo).toBe('simple');
        expect(plan.producto).toMatchObject({ type: 'simple', status: 'draft', name: 'Sábana Premium', sku: 'SKU-1', regular_price: '100.00', sale_price: '', manage_stock: true, stock_quantity: 5, stock_status: 'instock' });
        expect(plan.producto.images).toEqual([{ src: 'https://c.com/1.jpg' }]);
    });

    it('el precio web menor va como precio de oferta; uno mayor o igual se ignora', () => {
        expect(preciosDe({ sku: 'a', price: 100, webPrice: 80 })).toEqual({ regular_price: '100.00', sale_price: '80.00' });
        expect(preciosDe({ sku: 'a', price: 100, webPrice: 100 }).sale_price).toBe('');
        expect(preciosDe({ sku: 'a', price: 100, webPrice: 150 }).sale_price).toBe('');
        expect(preciosDe({ sku: 'a', price: 100, webPrice: null }).sale_price).toBe('');
    });

    it('el descuento general vigente va como oferta, con sus fechas, y manda sobre el precio web', () => {
        const hoy = '2026-11-14';
        expect(preciosDe({ sku: 'a', price: 350, webPrice: 300, salePrice: 165, saleStartDate: '2026-11-14', saleEndDate: '2026-11-24' }, hoy)).toEqual({
            regular_price: '350.00', sale_price: '165.00', date_on_sale_from: '2026-11-14T00:00:00', date_on_sale_to: '2026-11-24T23:59:59',
        });
        // Sin fecha de inicio solo lleva la de fin.
        expect(preciosDe({ sku: 'a', price: 350, salePrice: 165, saleEndDate: '2026-11-24' }, hoy)).toEqual({ regular_price: '350.00', sale_price: '165.00', date_on_sale_to: '2026-11-24T23:59:59' });
    });

    it('un descuento vencido, inválido o no menor que el precio se ignora (cae al precio web, si hay)', () => {
        const hoy = '2026-11-25';
        expect(preciosDe({ sku: 'a', price: 350, webPrice: 300, salePrice: 165, saleEndDate: '2026-11-24' }, hoy)).toEqual({ regular_price: '350.00', sale_price: '300.00' });
        expect(preciosDe({ sku: 'a', price: 350, salePrice: 400, saleEndDate: '2026-12-31' }, '2026-11-14').sale_price).toBe('');
        expect(preciosDe({ sku: 'a', price: 350, salePrice: 165, saleStartDate: '2026-12-01', saleEndDate: '2026-11-20' }, '2026-11-14').sale_price).toBe('');
    });

    it('sin precio no se publica: lo dice con el SKU', () => {
        expect(() => planificarWoo([producto({ price: null })])).toThrow(/SKU-1.*precio/);
        expect(() => planificarWoo([producto({ price: 0 })])).toThrow(PlanInvalido);
    });

    it('sin stock queda «agotado» y el stock nunca es negativo', () => {
        expect(planificarWoo([producto({ stock: 0 })]).producto.stock_status).toBe('outofstock');
        expect(planificarWoo([producto({ stock: -3 })]).producto.stock_quantity).toBe(0);
    });

    it('sin SKU no se publica', () => {
        expect(() => planificarWoo([producto({ sku: '  ' })])).toThrow(/SKU/);
    });

    it('solo manda fotos https, sin repetir y con tope', () => {
        const fotos = [{ url: 'http://x.com/a.jpg' }, { url: 'https://x.com/b.jpg' }, { url: 'https://x.com/b.jpg' }, { url: '' }];
        expect(fotosHttps({ images: fotos })).toEqual(['https://x.com/b.jpg']);
        const muchas = Array.from({ length: 30 }, (_, i) => ({ url: `https://x.com/${i}.jpg` }));
        expect(fotosHttps({ images: muchas }, 10)).toHaveLength(10);
    });
});

describe('woo-plan · descripción, peso y categorías', () => {
    it('prefiere la ficha HTML de la agencia', () => {
        expect(descripcionParaWoo({ aiAttributes: { descriptionHtml: '<div>Ficha</div>' }, aiDescription: 'otro', description: 'x' })).toBe('<div>Ficha</div>');
    });
    it('si no hay ficha HTML, convierte el texto en párrafos y escapa el HTML', () => {
        expect(descripcionParaWoo({ aiAttributes: null, aiDescription: null, description: 'Hola & <3\n\nSegundo\nrenglón' })).toBe('<p>Hola &amp; &lt;3</p><p>Segundo<br>renglón</p>');
    });
    it('un texto que ya trae etiquetas HTML se deja tal cual', () => {
        expect(descripcionParaWoo({ aiAttributes: null, aiDescription: '<p>Ya es HTML</p>', description: '' })).toBe('<p>Ya es HTML</p>');
    });
    it('peso y medidas solo si están completos', () => {
        expect(pesoYMedidas({ packageWeight: '1.5', packageWidth: 10, packageLength: 20, packageHeight: 5 })).toEqual({ weight: '1.5', dimensions: { length: '20', width: '10', height: '5' } });
        expect(pesoYMedidas({ packageWeight: null, packageWidth: 10, packageLength: null, packageHeight: 5 })).toEqual({});
    });
});

describe('woo-plan · grupo de variantes', () => {
    const grupo = { name: 'Sábanas Casatex', axes: [{ name: 'Color', values: ['Rojo', 'Azul'] }, { name: 'Talla', values: ['2P', '1.5P'] }] };
    const variante = (n: number, color: string, talla: string, sobre: Partial<ProductoParaWoo> = {}) => producto({
        id: `p${n}`, sku: `S-${n}`, variantValues: { Color: color, Talla: talla }, images: [{ url: `https://c.com/${n}.jpg` }, { url: `https://c.com/${n}b.jpg` }], ...sobre,
    });

    it('un grupo es UN producto variable con una variación por variante', () => {
        const plan = planificarWoo([variante(1, 'Rojo', '2P'), variante(2, 'Rojo', '1.5P'), variante(3, 'Azul', '2P')], grupo);
        expect(plan.tipo).toBe('variable');
        expect(plan.producto).toMatchObject({ type: 'variable', status: 'draft', name: 'Sábanas Casatex' });
        expect(plan.producto.sku).toBeUndefined();
        expect(plan.producto.attributes).toEqual([
            { name: 'Color', position: 0, visible: true, variation: true, options: ['Rojo', 'Azul'] },
            { name: 'Talla', position: 1, visible: true, variation: true, options: ['2P', '1.5P'] },
        ]);
        expect(plan.variaciones).toHaveLength(3);
        expect(plan.variaciones[2].body).toMatchObject({ sku: 'S-3', regular_price: '100.00', stock_quantity: 5, attributes: [{ name: 'Color', option: 'Azul' }, { name: 'Talla', option: '2P' }], image: { src: 'https://c.com/3.jpg' } });
    });

    it('las fotos del padre empiezan por la principal de cada variante', () => {
        const plan = planificarWoo([variante(1, 'Rojo', '2P'), variante(2, 'Azul', '2P')], grupo);
        expect(plan.producto.images.map((i: any) => i.src)).toEqual(['https://c.com/1.jpg', 'https://c.com/2.jpg', 'https://c.com/1b.jpg', 'https://c.com/2b.jpg']);
    });

    it('solo lista los valores que alguna variante usa', () => {
        const plan = planificarWoo([variante(1, 'Rojo', '2P')], grupo);
        expect(plan.producto.attributes[0].options).toEqual(['Rojo']);
    });

    it('falla con el SKU cuando una variante no tiene valor en un eje', () => {
        expect(() => planificarWoo([variante(1, 'Rojo', '2P'), variante(2, '', '2P')], grupo)).toThrow(/S-2.*Color/);
    });

    it('rechaza SKU repetidos y combinaciones repetidas', () => {
        expect(() => planificarWoo([variante(1, 'Rojo', '2P'), variante(1, 'Azul', '2P')], grupo)).toThrow(/repetido/);
        expect(() => planificarWoo([variante(1, 'Rojo', '2P'), variante(2, 'rojo', '2p')], grupo)).toThrow(/misma combinación/);
    });

    it('las variaciones de un grupo llevan el descuento general de cada variante', () => {
        const futuro = { salePrice: 60, saleStartDate: '2999-01-01', saleEndDate: '2999-12-31' };
        const plan = planificarWoo([variante(1, 'Rojo', '2P', { price: 120, ...futuro }), variante(2, 'Azul', '2P', { price: 80 })], grupo);
        expect(plan.variaciones[0].body).toMatchObject({ regular_price: '120.00', sale_price: '60.00', date_on_sale_from: '2999-01-01T00:00:00', date_on_sale_to: '2999-12-31T23:59:59' });
        expect(plan.variaciones[1].body).toMatchObject({ regular_price: '80.00', sale_price: '' });
    });

    it('cada variante lleva su propio precio y su oferta', () => {
        const plan = planificarWoo([variante(1, 'Rojo', '2P', { price: 120, webPrice: 99 }), variante(2, 'Azul', '2P', { price: 80 })], grupo);
        expect(plan.variaciones[0].body).toMatchObject({ regular_price: '120.00', sale_price: '99.00' });
        expect(plan.variaciones[1].body).toMatchObject({ regular_price: '80.00', sale_price: '' });
    });

    it('un grupo sin ejes se publica como producto simple', () => {
        expect(planificarWoo([producto()], { name: 'G', axes: [] }).tipo).toBe('simple');
    });
});
