import { datosConocidos, textoDeDatosConocidos } from './datos-conocidos';

describe('datosConocidos', () => {
    const atributos = {
        Material: 'Poliéster', Capacidad: '15 L', Alto: '26', Ancho: '17', Largo: '26', Forma: 'Cuadrada',
        Color: 'Marrón', ColorBasico: 'Marrón', brand: 'GENERICO', NameCn: 'LONCHERA', SellerWarranty: '1 mes',
        descriptionHtml: '<div>...</div>', vision: { productType: 'lonchera' }, _importado: '{"x":1}', _ia: ['brand'],
        mercadolibre_attributes: { A: 1 }, ripley_attributes: { color_80: 'Marrón' }, estimated: { measures: true },
        vacio: '', nulo: null, desconocido: 'N/A',
    };

    it('deja solo lo que describe al producto', () => {
        expect(datosConocidos(atributos)).toEqual({ Material: 'Poliéster', Capacidad: '15 L', Alto: '26', Ancho: '17', Largo: '26', Forma: 'Cuadrada' });
    });

    it('no pasa el color ni la talla: eso es propio de cada variante y de los ejes', () => {
        const r = datosConocidos({ Color: 'Rojo', Talla: 'M', Material: 'Algodón' });
        expect(r).toEqual({ Material: 'Algodón' });
    });

    it('suma datos extra (por ejemplo las medidas del paquete) y descarta los vacíos', () => {
        expect(datosConocidos({ Material: 'Cuero' }, { 'Peso del paquete (kg)': 0.4, 'Ancho del paquete (cm)': null })).toEqual({ Material: 'Cuero', 'Peso del paquete (kg)': '0.4' });
    });

    it('un texto demasiado largo (una descripción) no es un dato', () => {
        expect(datosConocidos({ Detalle: 'x'.repeat(200) })).toEqual({});
    });

    it('sin atributos no falla', () => {
        expect(datosConocidos(undefined)).toEqual({});
        expect(datosConocidos(null, {})).toEqual({});
    });
});

describe('textoDeDatosConocidos', () => {
    it('arma el párrafo con una línea por dato', () => {
        const t = textoDeDatosConocidos({ Material: 'Poliéster', Capacidad: '15 L' });
        expect(t).toContain('- Material: Poliéster');
        expect(t).toContain('- Capacidad: 15 L');
        expect(t).toContain('NO los contradigas');
    });

    it('sin datos no añade nada', () => {
        expect(textoDeDatosConocidos({})).toBe('');
        expect(textoDeDatosConocidos(undefined)).toBe('');
    });
});
