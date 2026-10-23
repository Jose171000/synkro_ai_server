import { validarPropuestaDeIA } from './falabella/ejes-ia';

/**
 * La IA propone ejes y valores, pero NADA se aplica sin comprobarlo: cada valor tiene que estar escrito en los datos de
 * su propia ficha (título, variación, atributos o SKU). Lo que no se puede comprobar pasa a la revisión manual.
 */
const ficha = (sellerSku: string, nombre: string, over: any = {}) => ({ sellerSku, nombre, variation: null, atributos: {}, ...over });
const propuesta = (valores: Record<string, Record<string, string>>, over: any = {}) => ({
    ejes: [{ nombre: 'Color', evidencia: 'título' }],
    valores,
    confianza: 'alta' as const,
    ...over,
});

describe('validarPropuestaDeIA', () => {
    const fichas = [
        ficha('BL-K-RPA', 'Sábana Bordada King Rosa Pastel'),
        ficha('BL-K-NGR', 'Sábana Bordada King Negro'),
    ];

    it('acepta una propuesta cuyos valores están escritos en cada ficha', () => {
        const r = validarPropuestaDeIA(fichas, propuesta({ 'BL-K-RPA': { Color: 'Rosa Pastel' }, 'BL-K-NGR': { Color: 'Negro' } }));
        expect(r.plan).toMatchObject({ origen: 'ia', axes: [{ name: 'Color', values: ['Rosa Pastel', 'Negro'] }] });
        expect(r.plan!.variants).toEqual([
            { sellerSku: 'BL-K-RPA', values: { Color: 'Rosa Pastel' } },
            { sellerSku: 'BL-K-NGR', values: { Color: 'Negro' } },
        ]);
    });

    it('acepta un valor que está literalmente en el SKU (…-BEIGE)', () => {
        const r = validarPropuestaDeIA(
            [ficha('CN-26-BEIGE', 'Edredón Importado 2 PLZ'), ficha('CN-26-TURQUESA', 'Edredón Importado 2 PLZ')],
            propuesta({ 'CN-26-BEIGE': { Color: 'Beige' }, 'CN-26-TURQUESA': { Color: 'Turquesa' } }),
        );
        expect(r.plan!.axes[0].values).toEqual(['Beige', 'Turquesa']);
    });

    it('rechaza un valor que no aparece escrito en la ficha (código de SKU traducido por la IA)', () => {
        const r = validarPropuestaDeIA(
            [ficha('CN-26-RO', 'Edredón Importado 2 PLZ'), ficha('CN-26-UV', 'Edredón Importado 2 PLZ')],
            propuesta({ 'CN-26-RO': { Color: 'Rosa' }, 'CN-26-UV': { Color: 'Uva' } }),
        );
        expect(r.plan).toBeNull();
        expect(r.motivo).toMatch(/no aparece escrito.*no se puede comprobar/);
    });

    it('un código del SKU que no es un color («PP») no se acepta aunque esté escrito en el SKU', () => {
        const r = validarPropuestaDeIA(
            [ficha('EDRDN-3PCS-T-PP', 'Set Edredón Reversible 3 Piezas'), ficha('EDRDN-3PCS-T-UVA', 'Set Edredón Reversible 3 Piezas')],
            propuesta({ 'EDRDN-3PCS-T-PP': { Color: 'PP' }, 'EDRDN-3PCS-T-UVA': { Color: 'Uva' } }),
        );
        expect(r.plan).toBeNull();
        expect(r.motivo).toMatch(/PP/);
    });

    it('un color escrito en palabras sí se acepta aunque en el SKU vaya pegado («BEIGECLARO» → «Beige claro»)', () => {
        const r = validarPropuestaDeIA(
            [ficha('EDRDN-3PCS-T-BEIGECLARO', 'Set Edredón Reversible'), ficha('EDRDN-3PCS-T-AZULACERO', 'Set Edredón Reversible')],
            propuesta({ 'EDRDN-3PCS-T-BEIGECLARO': { Color: 'Beige claro' }, 'EDRDN-3PCS-T-AZULACERO': { Color: 'Azul acero' } }),
        );
        expect(r.plan!.axes[0].values).toEqual(['Beige claro', 'Azul acero']);
    });

    it('rechaza si la IA dice que no está segura', () => {
        const r = validarPropuestaDeIA(fichas, propuesta({ 'BL-K-RPA': { Color: 'Rosa Pastel' }, 'BL-K-NGR': { Color: 'Negro' } }, { confianza: 'baja', motivo: 'títulos iguales' }));
        expect(r.plan).toBeNull();
        expect(r.motivo).toBe('títulos iguales');
    });

    it.each([
        ['sin propuesta', null],
        ['sin ejes', propuesta({}, { ejes: [] })],
        ['más de 3 ejes', propuesta({}, { ejes: ['A', 'B', 'C', 'D'].map((nombre) => ({ nombre })) })],
        ['ejes repetidos', propuesta({}, { ejes: [{ nombre: 'Color' }, { nombre: 'color' }] })],
    ])('rechaza una propuesta inválida (%s)', (_c, p) => {
        expect(validarPropuestaDeIA(fichas, p as any).plan).toBeNull();
    });

    it('rechaza si falta el valor de algún SKU', () => {
        const r = validarPropuestaDeIA(fichas, propuesta({ 'BL-K-RPA': { Color: 'Rosa Pastel' } }));
        expect(r.plan).toBeNull();
        expect(r.motivo).toMatch(/BL-K-NGR/);
    });

    it('rechaza un eje que no distingue nada', () => {
        const iguales = [ficha('A', 'Sábana Rojo'), ficha('B', 'Sábana Rojo')];
        expect(validarPropuestaDeIA(iguales, propuesta({ A: { Color: 'Rojo' }, B: { Color: 'Rojo' } })).plan).toBeNull();
    });

    it('con dos ejes, cada valor respaldado en su ficha y combinación única', () => {
        const dos = [ficha('P1', 'Polo Rojo S'), ficha('P2', 'Polo Rojo M'), ficha('P3', 'Polo Azul S')];
        const r = validarPropuestaDeIA(dos, {
            ejes: [{ nombre: 'Color' }, { nombre: 'Talla' }],
            valores: { P1: { Color: 'Rojo', Talla: 'S' }, P2: { Color: 'Rojo', Talla: 'M' }, P3: { Color: 'Azul', Talla: 'S' } },
            confianza: 'media',
        });
        expect(r.plan!.axes.map((e) => e.name)).toEqual(['Color', 'Talla']);
    });
});
