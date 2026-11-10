import { buscarMarcas, marcaExacta, MARCA_GENERICA, normalizarMarca, revisarMarca } from './ripley-marcas';

const MARCAS = ['ADIDAS', 'ADIDAS ORIGINALS', 'BABY GAP', 'GAP', 'GENÉRICO', 'OCEANO', 'TIGO KIDS', 'THE NORTH FACE', 'NORTH SAILS', 'ÑANDÚ'];

describe('normalizarMarca', () => {
    it('ignora mayúsculas, tildes y signos (la ñ cuenta como n, así quien escribe «nandu» encuentra «ÑANDÚ»)', () => {
        expect(normalizarMarca('  Genérico! ')).toBe('GENERICO');
        expect(normalizarMarca('ñandú')).toBe('NANDU');
    });
});

describe('buscarMarcas', () => {
    it('primero las que empiezan por el texto, luego las que lo contienen', () => {
        expect(buscarMarcas(MARCAS, 'gap')).toEqual(['GAP', 'BABY GAP']);
        expect(buscarMarcas(MARCAS, 'north')).toEqual(['NORTH SAILS', 'THE NORTH FACE']);
    });

    it('la coincidencia exacta va primero', () => {
        expect(buscarMarcas(MARCAS, 'adidas')[0]).toBe('ADIDAS');
    });

    it('encuentra aunque falten tildes o sobren mayúsculas', () => {
        expect(buscarMarcas(MARCAS, 'generico')).toEqual([MARCA_GENERICA]);
    });

    it('sin texto devuelve las primeras, y respeta el máximo', () => {
        expect(buscarMarcas(MARCAS, '', 3)).toHaveLength(3);
        expect(buscarMarcas(MARCAS, 'a', 2)).toHaveLength(2);
    });

    it('un texto que no está en ninguna marca da lista vacía', () => {
        expect(buscarMarcas(MARCAS, 'zzzz')).toEqual([]);
        expect(buscarMarcas(undefined as any, 'x')).toEqual([]);
    });
});

describe('marcaExacta y revisarMarca', () => {
    it('devuelve la marca escrita como la tiene Ripley', () => {
        expect(marcaExacta(MARCAS, 'genérico')).toBe('GENÉRICO');
        expect(marcaExacta(MARCAS, 'The North Face')).toBe('THE NORTH FACE');
        expect(marcaExacta(MARCAS, 'Tigo')).toBeNull();
    });

    it('una marca válida no trae sugerencias', () => {
        expect(revisarMarca(MARCAS, 'oceano')).toEqual({ valor: 'oceano', valida: true, canonica: 'OCEANO', sugerencias: [] });
    });

    it('una marca que no existe avisa y sugiere parecidas', () => {
        const r = revisarMarca(MARCAS, 'Tigo');
        expect(r.valida).toBe(false);
        expect(r.canonica).toBeNull();
        expect(r.sugerencias).toContain('TIGO KIDS');
    });

    it('vacía no es válida', () => {
        expect(revisarMarca(MARCAS, '').valida).toBe(false);
    });
});
