import { normalizarColores } from './product-vision.service';

describe('colores sugeridos por foto', () => {
    const skus = ['A', 'B', 'C'];
    it('acepta un color corto y distinto por foto, por número de foto', () => {
        expect(normalizarColores({ fotos: [{ foto: 2, color: 'negro' }, { foto: 1, color: 'ROSADO' }, { foto: 3, color: 'Azul marino' }] }, skus))
            .toEqual({ A: 'Rosado', B: 'Negro', C: 'Azul marino' });
    });
    it('si falta una foto, hay un color repetido o uno sin valor, no sugiere nada', () => {
        expect(normalizarColores({ fotos: [{ foto: 1, color: 'Rojo' }, { foto: 2, color: 'Azul' }] }, skus)).toEqual({});
        expect(normalizarColores({ fotos: [{ foto: 1, color: 'Rojo' }, { foto: 2, color: 'rojo' }, { foto: 3, color: 'Azul' }] }, skus)).toEqual({});
        expect(normalizarColores({ fotos: [{ foto: 1, color: 'Rojo' }, { foto: 2, color: null }, { foto: 3, color: 'Azul' }] }, skus)).toEqual({});
    });
    it('rechaza textos largos o basura', () => {
        expect(normalizarColores({ fotos: [{ foto: 1, color: 'un color muy raro de describir aquí' }, { foto: 2, color: 'a' }, { foto: 3, color: 'b' }] }, skus)).toEqual({});
        expect(normalizarColores(null, skus)).toEqual({});
    });
});
