import { ajustesDe, guardarAjustes, opcionDeLaLista, unirAjustes, valorConAjuste } from './ajustes-de-canal';
import { revisarCompatibilidad } from './compatibilidad-variantes';
import { VariantCompatService } from './variant-compat.service';
import { opcionCercana } from '../common/opcion-cercana';

const COLORES = ['Azul', 'Gris', 'Blanco', 'Negro', 'Rosa'];
const sinAutomatico = (v: string, o: string[]) => o.find((x) => x === v) ?? null; // solo coincidencia exacta

describe('ajustes de valores por canal', () => {
    it('guarda por canal y clase, sin tocar el objeto original ni los demás canales', () => {
        const original = { brand: 'X' };
        const a = guardarAjustes(original, 'Falabella', [{ clase: 'color', valor: 'Plomo Intermedio', opcion: 'Gris' }]);
        expect(original).toEqual({ brand: 'X' });
        expect(ajustesDe(a, 'falabella')).toEqual({ color: { 'plomo intermedio': 'Gris' } });
        expect(ajustesDe(a, 'ripley')).toEqual({});
        // Se acumula y actualiza sin perder lo anterior.
        const b = guardarAjustes(a, 'falabella', [{ clase: 'color', valor: 'Celeste', opcion: 'Azul' }, { clase: 'color', valor: 'plomo  intermedio', opcion: 'Negro' }]);
        expect(ajustesDe(b, 'falabella').color).toEqual({ 'plomo intermedio': 'Negro', celeste: 'Azul' });
    });

    it('el ajuste confirmado manda sobre la regla automática, pero solo si sigue siendo una opción válida', () => {
        const attrs = guardarAjustes({}, 'falabella', [{ clase: 'color', valor: 'Celeste', opcion: 'Gris' }]);
        const pedir = (atributos: any, opciones = COLORES) => valorConAjuste({ canal: 'falabella', atributos, atributo: 'Color básico variant', valor: 'Celeste', opciones, automatico: () => 'Azul' });
        expect(pedir(attrs)).toBe('Gris');
        expect(pedir({})).toBe('Azul');
        expect(pedir(attrs, ['Azul', 'Negro'])).toBe('Azul'); // «Gris» ya no existe en la lista: vale la regla automática
    });

    it('un ajuste de color no se usa en un dato de otra clase (talla)', () => {
        const attrs = guardarAjustes({}, 'falabella', [{ clase: 'color', valor: 'M', opcion: 'Gris' }]);
        expect(valorConAjuste({ canal: 'falabella', atributos: attrs, atributo: 'Talla', valor: 'M', opciones: ['S', 'M'], automatico: (v) => v })).toBe('M');
    });

    it('opcionDeLaLista devuelve la escritura exacta del canal y null si no está', () => {
        expect(opcionDeLaLista('gris', COLORES)).toBe('Gris');
        expect(opcionDeLaLista('Plata', COLORES)).toBeNull();
    });

    it('unirAjustes junta los de todas las variantes', () => {
        const a = guardarAjustes({}, 'ripley', [{ clase: 'color', valor: 'A', opcion: 'Azul' }]);
        const b = guardarAjustes({}, 'ripley', [{ clase: 'color', valor: 'B', opcion: 'Rosa' }]);
        expect(unirAjustes([a, b, null], 'ripley')).toEqual({ color: { a: 'Azul', b: 'Rosa' } });
    });
});

describe('revisión de compatibilidad con ajustes y colisiones', () => {
    const ejes = [{ name: 'Color', values: ['Celeste', 'Turquesa', 'Plata', 'Negro'] }];
    const info = (extra: any = {}) => ({ canal: 'falabella', categoryId: '1', admite: true, ejes: [{ id: 'ColorVariant', label: 'Color variant', options: COLORES }], automatico: opcionCercana, ...extra });

    it('un valor sin opción en la lista se avisa; con un ajuste confirmado deja de avisarse', () => {
        const sin = revisarCompatibilidad(ejes, info({ automatico: sinAutomatico }));
        expect(sin.valoresSinEquivalente[0].valores).toEqual(expect.arrayContaining(['Celeste', 'Turquesa', 'Plata']));
        const con = revisarCompatibilidad(ejes, info({ automatico: sinAutomatico, ajustes: { color: { celeste: 'Azul', turquesa: 'Azul', plata: 'Gris' } } }));
        expect(con.valoresSinEquivalente).toEqual([]);
    });

    it('dos valores distintos que caen en la misma opción se avisan como colisión', () => {
        const r = revisarCompatibilidad(ejes, info({ automatico: sinAutomatico, ajustes: { color: { celeste: 'Azul', turquesa: 'Azul', plata: 'Gris' } } }));
        expect(r.colisiones).toEqual([{ eje: 'Color', atributo: 'ColorVariant', opcion: 'Azul', valores: ['Celeste', 'Turquesa'] }]);
        expect(r.avisos.join(' ')).toContain('«Azul»');
    });

    it('un ajuste a una opción que ya no existe en la lista se ignora', () => {
        const r = revisarCompatibilidad(ejes, info({ automatico: sinAutomatico, ajustes: { color: { celeste: 'Violeta' } } }));
        expect(r.valoresSinEquivalente[0].valores).toContain('Celeste');
    });
});

describe('sugerir y aplicar ajustes de un grupo', () => {
    const variante = (id: string, color: string, extra: any = {}) => ({ id, variantValues: { Color: color }, aiAttributes: {}, marketplaceIds: { falabella_category_id: '1' }, images: [{ url: `https://x/${id}.jpg` }], ...extra });
    const construir = (opts: { sugeridas?: any[] } = {}) => {
        const s: any = Object.create(VariantCompatService.prototype);
        const variantes = [variante('1', 'Celeste'), variante('2', 'Turquesa'), variante('3', 'Negro')];
        s.grupos = { obtener: jest.fn(async () => ({ name: 'Sábanas', axes: [{ name: 'Color', values: ['Celeste', 'Turquesa', 'Negro'] }] })) };
        s.productos = { find: jest.fn(async () => variantes), save: jest.fn(async (v: any) => v) };
        s.infoDe = jest.fn(async () => ({ canal: 'ripley', categoryId: '1', admite: true, ejes: [{ id: 'color', label: 'Color', options: COLORES }] }));
        s.ai = { sugerirOpcionesDeLista: jest.fn(async () => opts.sugeridas ?? [{ valor: 'Celeste', opcion: 'Azul', motivo: 'Tono azul claro', origen: 'ia' }, { valor: 'Turquesa', opcion: 'Azul', motivo: 'Por la foto', origen: 'foto' }]) };
        return { s, variantes };
    };

    it('propone una opción por cada valor sin equivalente, con foto de su variante, y marca sus colisiones', async () => {
        const { s } = construir();
        const r = await s.sugerirAjustes('g', 'ripley', { userId: 'u', storeId: 's' });
        expect(r).toHaveLength(1);
        expect(r[0].opciones).toEqual(COLORES);
        expect(r[0].items.map((i: any) => [i.valor, i.opcion, i.origen])).toEqual([['Celeste', 'Azul', 'ia'], ['Turquesa', 'Azul', 'foto']]);
        const enviado = s.ai.sugerirOpcionesDeLista.mock.calls[0][0];
        expect(enviado.valores.map((v: any) => v.valor)).toEqual(['Celeste', 'Turquesa']);
        expect(enviado.valores[0].imagen).toBe('https://x/1.jpg');
    });

    it('aplicar guarda en todas las variantes y rechaza opciones que no existen en el canal', async () => {
        const { s, variantes } = construir();
        const r = await s.aplicarAjustes('g', 'ripley', [{ eje: 'Color', valor: 'Celeste', opcion: 'azul' }], { userId: 'u', storeId: 's' });
        expect(r).toEqual({ aplicados: 1, variantes: 3 });
        expect(ajustesDe(variantes[2].aiAttributes, 'ripley')).toEqual({ color: { celeste: 'Azul' } });
        await expect(s.aplicarAjustes('g', 'ripley', [{ eje: 'Color', valor: 'Celeste', opcion: 'Violeta' }], { userId: 'u', storeId: 's' })).rejects.toThrow('no es una opción válida');
    });
});
