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
