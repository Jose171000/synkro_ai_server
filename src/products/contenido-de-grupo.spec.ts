import { marcaMasUsada, planDeContenidoComun, VarianteConContenido } from './contenido-de-grupo';

const v = (id: string, over: Partial<VarianteConContenido> = {}): VarianteConContenido => ({ id, publicada: false, brand: null, descriptionHtml: null, aiDescription: null, ...over });

describe('contenido común de un grupo de variantes', () => {
    it('el caso del colchón: 4 variantes con marcas mezcladas quedan con la misma marca', () => {
        const familia = [v('q', { brand: 'GENERICO' }), v('k', { brand: 'Karmont' }), v('a', { brand: 'GENERICO' }), v('b', { brand: 'Karmont' })];
        const plan = planDeContenidoComun(familia, 'q', { brand: 'GENERICO' });
        expect(plan.actualizar.map((x) => x.id).sort()).toEqual(['b', 'k']);
        expect(plan.actualizar.every((x) => x.brand === 'GENERICO')).toBe(true);
        expect(plan.publicadasDistintas).toEqual([]);
    });

    it('la ficha HTML y la descripción de una variante se copian a las demás sin publicar; las que ya la tienen igual no se tocan', () => {
        const familia = [v('q'), v('k', { descriptionHtml: '<p>otra</p>' }), v('a', { descriptionHtml: '<p>ficha</p>', aiDescription: 'texto' })];
        const plan = planDeContenidoComun(familia, 'q', { descriptionHtml: '<p>ficha</p>', aiDescription: 'texto' });
        expect(plan.actualizar).toEqual([{ id: 'k', descriptionHtml: '<p>ficha</p>', aiDescription: 'texto' }]);
    });

    it('una variante ya publicada no se cambia: se avisa', () => {
        const plan = planDeContenidoComun([v('q'), v('p', { publicada: true, brand: 'Karmont' })], 'q', { brand: 'GENERICO' });
        expect(plan.actualizar).toEqual([]);
        expect(plan.publicadasDistintas).toEqual(['p']);
    });

    it('nunca toca a la variante de origen ni escribe campos vacíos', () => {
        const plan = planDeContenidoComun([v('q', { brand: 'X' }), v('k', { descriptionHtml: '<p>a</p>' })], 'q', { descriptionHtml: '   ', aiDescription: '' });
        expect(plan).toEqual({ actualizar: [], publicadasDistintas: [] });
    });

    it('la marca más usada entre las válidas; sin válidas no hay marca', () => {
        expect(marcaMasUsada(['Nike', 'Adidas', 'Nike'])).toBe('Nike');
        expect(marcaMasUsada([])).toBeUndefined();
    });
});
