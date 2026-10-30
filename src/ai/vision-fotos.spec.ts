import { huellaDeFotos, necesitaVision } from './vision-fotos';
import { combinarAtributos } from './combinar-atributos';

describe('huella de las fotos analizadas', () => {
    it('es la misma para las mismas fotos y cambia si cambia alguna de las 4 que se analizan', () => {
        const fotos = ['https://i/1.jpg', 'https://i/2.jpg', 'https://i/3.jpg', 'https://i/4.jpg'];
        expect(huellaDeFotos(fotos)).toBe(huellaDeFotos([...fotos]));
        expect(huellaDeFotos(fotos)).not.toBe(huellaDeFotos(['https://i/9.jpg', ...fotos.slice(1)]));
        expect(huellaDeFotos(fotos)).not.toBe(huellaDeFotos([...fotos].reverse()));
    });

    it('una quinta foto no cambia la huella: la IA solo analiza las 4 primeras', () => {
        const cuatro = ['https://i/1.jpg', 'https://i/2.jpg', 'https://i/3.jpg', 'https://i/4.jpg'];
        expect(huellaDeFotos([...cuatro, 'https://i/5.jpg'])).toBe(huellaDeFotos(cuatro));
    });
});

describe('cuándo hay que volver a analizar las fotos', () => {
    const fotos = ['https://i/1.jpg'];
    const vigente = { vision: { productType: 'x' }, _visionFotos: huellaDeFotos(fotos) };

    it('nunca analizadas, cambiadas o sin huella: sí', () => {
        expect(necesitaVision({}, fotos)).toBe(true);
        expect(necesitaVision(vigente, ['https://i/otra.jpg'])).toBe(true);
        expect(necesitaVision({ vision: { productType: 'x' } }, fotos)).toBe(true);
    });

    it('vigente: no, salvo que se fuerce', () => {
        expect(necesitaVision(vigente, fotos)).toBe(false);
        expect(necesitaVision(vigente, fotos, true)).toBe(true);
    });

    it('sin fotos analizables no hay nada que analizar', () => {
        expect(necesitaVision({}, [])).toBe(false);
        expect(necesitaVision({}, ['data:image/jpeg;base64,xx'], true)).toBe(false);
    });
});

describe('combinar atributos sin pisar lo que ya tenían', () => {
    it('lo que ya tiene valor se queda y la IA solo rellena lo vacío o lo que no existía', () => {
        const r = combinarAtributos({ brand: 'MUTANT', color: '', material: null, garantia: '12 meses' }, { brand: 'GENERICO', color: 'Negro', material: 'Metal', peso: '2 kg' });
        expect(r).toEqual({ brand: 'MUTANT', color: 'Negro', material: 'Metal', garantia: '12 meses', peso: '2 kg' });
    });

    it('los grupos de atributos (los de Mercado Libre) se combinan clave por clave', () => {
        const r = combinarAtributos(
            { mercadolibre_attributes: { BRAND: 'Mutant', COLOR: '' } },
            { mercadolibre_attributes: { BRAND: 'Genérico', COLOR: 'Rojo', FLAVOR: 'Vainilla' } },
        );
        expect(r.mercadolibre_attributes).toEqual({ BRAND: 'Mutant', COLOR: 'Rojo', FLAVOR: 'Vainilla' });
    });

    it('sin atributos previos o sin nuevos no falla', () => {
        expect(combinarAtributos(null, { a: '1' })).toEqual({ a: '1' });
        expect(combinarAtributos({ a: '1' }, undefined)).toEqual({ a: '1' });
    });
});
