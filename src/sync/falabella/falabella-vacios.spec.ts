process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { atributosObligatoriosAprendidos, decodificarEntidades, leerAtributosVacios } from './falabella-fields';

describe('atributos que Falabella exige vacíos', () => {
    it('decodifica las entidades del mensaje', () => {
        expect(decodificarEntidades("3: Field &#039;TamanoCamaVariant&#039; cannot be empty")).toBe("3: Field 'TamanoCamaVariant' cannot be empty");
    });

    it('lee los campos que no pueden ir vacíos, con o sin entidades', () => {
        expect(leerAtributosVacios("3: Field 'TamanoCamaVariant' cannot be empty")).toEqual(['TamanoCamaVariant']);
        expect(leerAtributosVacios('Field &#039;Color&#039; cannot be empty; Field &#039;Talla&#039; cannot be empty')).toEqual(['Color', 'Talla']);
        expect(leerAtributosVacios('otro error')).toEqual([]);
    });

    it('lo aprendido se compara sin importar mayúsculas ni guiones', () => {
        const aprendidos = atributosObligatoriosAprendidos({ _obligatorios: ['TamanoCamaVariant'] });
        expect(aprendidos.has('tamanocamavariant')).toBe(true);
        expect(atributosObligatoriosAprendidos(null).size).toBe(0);
    });
});

import { esCampoNumerico, soloElNumero } from './falabella-fields';

describe('campos numéricos de Falabella', () => {
    it('reconoce los campos numéricos por su tipo de entrada', () => {
        expect(esCampoNumerico('numberfield')).toBe(true);
        expect(esCampoNumerico('textfield')).toBe(false);
        expect(esCampoNumerico('dropdown')).toBe(false);
        expect(esCampoNumerico(undefined)).toBe(false);
    });

    it('deja solo el número: «3000 hilos» → «3000»', () => {
        expect(soloElNumero('3000 hilos')).toBe('3000');
        expect(soloElNumero('1,5 kg')).toBe('1.5');
        expect(soloElNumero('  12 ')).toBe('12');
        expect(soloElNumero('sin número')).toBeUndefined();
        expect(soloElNumero('')).toBeUndefined();
    });
});
