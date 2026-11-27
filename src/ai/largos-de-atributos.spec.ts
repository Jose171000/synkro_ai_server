import { acortarALoPermitido, notaDeLargo } from './largos-de-atributos';
import { limiteDeLongitud } from '../sync/falabella/falabella-fields';
import { atributosDeMeli } from './channel-attributes.service';

describe('máximo de caracteres de los atributos', () => {
    it('Falabella: 172 como tope, o menos si lo declaró o lo rechazó antes', () => {
        const campo = { name: 'composicion', feedName: 'Composicion', label: 'Composición', inputType: 'textfield' };
        expect(limiteDeLongitud(campo, null)).toBe(172);
        expect(limiteDeLongitud({ ...campo, maxLength: 255 }, null)).toBe(172);
        expect(limiteDeLongitud({ ...campo, maxLength: 60 }, null)).toBe(60);
        expect(limiteDeLongitud({ ...campo, maxLength: 255 }, { _maxLen: { composicion: 90 } })).toBe(90);
        expect(limiteDeLongitud({ ...campo, inputType: 'textarea' }, null)).toBe(172);
        expect(limiteDeLongitud({ ...campo, inputType: 'numberfield' }, null)).toBeUndefined();
        expect(limiteDeLongitud({ ...campo, options: ['A'] }, null)).toBeUndefined();
    });

    it('Mercado Libre: usa el máximo que declara la categoría en los textos libres', () => {
        const [texto, numero] = atributosDeMeli([
            { id: 'A', name: 'Composición', value_type: 'string', value_max_length: 255, tags: { required: true } },
            { id: 'B', name: 'Unidades', value_type: 'number', value_max_length: 18, tags: { required: true } },
        ]);
        expect(texto.maxLength).toBe(255);
        expect(numero.maxLength).toBeUndefined();
    });

    it('avisa el máximo a la IA y acorta lo que se pase sin partir palabras', () => {
        const atributos: any[] = [{ name: 'Composicion', maxLength: 20 }];
        const valores = { Composicion: 'creatina, arginina, magnesio y zinc' };
        expect(notaDeLargo(atributos[0])).toContain('MÁXIMO 20');
        acortarALoPermitido(valores, atributos);
        expect(valores.Composicion.length).toBeLessThanOrEqual(20);
        expect(valores.Composicion).toBe('creatina, arginina');
    });
});
