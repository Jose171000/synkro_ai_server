import { armarCsv, columnasDeAtributos, COLUMNAS_ANTES, COLUMNAS_DESPUES, filaDeRipley, MAX_NOMBRE, ProductoParaRipley, rutaParaCsv, validarProductoParaRipley } from './ripley-publicacion';

const CAMPOS = [
    { name: 'tipo_product', label: 'Tipo de producto', required: true },
    { name: 'color_80', label: 'Color', required: true, isVariant: true },
    { name: 'escolar', label: 'Escolar', required: true },
    { name: 'modelo', label: 'Modelo', required: false },
];

const lonchera = (over: Partial<ProductoParaRipley> = {}): ProductoParaRipley => ({
    sku: 'BP000007',
    categoria: { id: 'R141100000000', ruta: 'MALETERÍA, BOLSOS Y CARTERAS › LONCHERAS' },
    nombre: 'lonchera marrón térmica puffer poliéster 15 l doble compartimiento',
    descripcionCorta: 'Lonchera térmica tipo puffer.',
    descripcion: '<p>Lonchera "térmica"; con cierre</p>',
    marca: 'GENÉRICO', marcaValida: true,
    imagenes: ['https://x.com/a.jpg', 'https://x.com/b.jpg'],
    precio: 99, stock: 4,
    paquete: { largo: 26, ancho: 17, alto: 26, peso: 0.4 },
    atributos: { tipo_product: 'Loncheras', color_80: 'Marrón', escolar: 'No', modelo: 'LONCHERA PUFFER' },
    ...over,
});

describe('rutaParaCsv', () => {
    it('usa «/» como la plantilla del portal, no «›»', () => {
        expect(rutaParaCsv('MALETERÍA, BOLSOS Y CARTERAS › LONCHERAS')).toBe('MALETERÍA, BOLSOS Y CARTERAS/LONCHERAS');
        expect(rutaParaCsv('')).toBe('');
    });
});

describe('validarProductoParaRipley', () => {
    it('un producto completo no tiene errores ni avisos', () => {
        expect(validarProductoParaRipley(lonchera(), CAMPOS)).toEqual({ errores: [], avisos: [] });
    });

    it('lo que Ripley rechazaría sale como error, con un mensaje claro', () => {
        const r = validarProductoParaRipley(lonchera({ categoria: null, nombre: '', descripcionCorta: '', descripcion: '', marca: '', imagenes: [], precio: 0, stock: -1, atributos: {} }), CAMPOS);
        expect(r.errores).toEqual(expect.arrayContaining([
            'Falta la categoría de Ripley.', 'Falta el nombre para Ripley.', 'Falta la descripción corta.', 'Falta la descripción completa.',
            'Falta la marca.', 'Falta un precio mayor que cero.', 'El stock debe ser un número entero, cero o mayor.',
            'Falta el dato obligatorio «Tipo de producto».', 'Falta el dato obligatorio «Color».', 'Falta el dato obligatorio «Escolar».',
        ]));
        expect(r.errores.join(' ')).toContain('al menos una foto');
        expect(r.errores.join(' ')).not.toContain('Modelo');
    });

    it('el nombre de más de 125 caracteres y el SKU con «/» o muy largo se rechazan', () => {
        expect(validarProductoParaRipley(lonchera({ nombre: 'A'.repeat(MAX_NOMBRE + 1) }), CAMPOS).errores[0]).toContain(`hasta ${MAX_NOMBRE}`);
        expect(validarProductoParaRipley(lonchera({ sku: 'AB/12' }), CAMPOS).errores[0]).toContain('«/»');
        expect(validarProductoParaRipley(lonchera({ sku: 'X'.repeat(41) }), CAMPOS).errores[0]).toContain('40');
    });

    it('una marca que no está en el catálogo de Ripley es un error', () => {
        const r = validarProductoParaRipley(lonchera({ marca: 'TIGO', marcaValida: false }), CAMPOS);
        expect(r.errores[0]).toContain('«TIGO» no está en el catálogo aprobado de Ripley');
    });

    it('fotos que no son enlaces públicos son un error; sin extensión .jpg es solo un aviso', () => {
        expect(validarProductoParaRipley(lonchera({ imagenes: ['C:\\fotos\\a.jpg'] }), CAMPOS).errores.join(' ')).toContain('no es un enlace público');
        const r = validarProductoParaRipley(lonchera({ imagenes: ['https://media.falabella.com/falabellaPE/157753073_01'] }), CAMPOS);
        expect(r.errores).toEqual([]);
        expect(r.avisos.join(' ')).toContain('.jpg');
    });

    it('sin medidas del paquete es solo un aviso (Ripley las recomienda)', () => {
        const r = validarProductoParaRipley(lonchera({ paquete: null }), CAMPOS);
        expect(r.errores).toEqual([]);
        expect(r.avisos.join(' ')).toContain('medidas');
    });

    it('más de 10 fotos avisa que se enviarán las primeras 10', () => {
        const r = validarProductoParaRipley(lonchera({ imagenes: Array.from({ length: 12 }, (_, i) => `https://x.com/${i}.jpg`) }), CAMPOS);
        expect(r.avisos.join(' ')).toContain('primeras 10');
    });
});

describe('filaDeRipley', () => {
    const atributos = columnasDeAtributos(CAMPOS);
    const fila = filaDeRipley(lonchera(), atributos);

    it('pone el nombre en MAYÚSCULAS y la categoría como en la plantilla', () => {
        expect(fila.nombre).toBe('LONCHERA MARRÓN TÉRMICA PUFFER POLIÉSTER 15 L DOBLE COMPARTIMIENTO');
        expect(fila.categoria).toBe('MALETERÍA, BOLSOS Y CARTERAS/LONCHERAS');
    });

    it('la oferta usa el SKU del vendedor, el estado «Nuevo» y la actualización', () => {
        expect(fila).toMatchObject({ sku: 'BP000007', sku_seller: 'BP000007', 'product-id': 'BP000007', 'product-id-type': 'SHOP_SKU', state: 'Nuevo', 'update-delete': 'UPDATE', price: '99', quantity: '4', is_displayable: 'true' });
    });

    it('la primera foto es la imagen y la miniatura; las demás van en imagen2…', () => {
        expect(fila.imagen).toBe('https://x.com/a.jpg');
        expect(fila.thumbnail).toBe('https://x.com/a.jpg');
        expect(fila.imagen2).toBe('https://x.com/b.jpg');
    });

    it('los atributos van en sus columnas y las medidas del paquete como números', () => {
        expect(fila).toMatchObject({ tipo_product: 'Loncheras', color_80: 'Marrón', escolar: 'No', modelo: 'LONCHERA PUFFER', largo_empaque: '26', peso_empaque: '0.4' });
    });

    it('sin variantes el variant_id queda vacío; con variantes lleva el código común', () => {
        expect(fila.variant_id).toBe('');
        expect(filaDeRipley(lonchera({ varianteDe: 'GRP-1' }), atributos).variant_id).toBe('GRP-1');
    });
});

describe('columnasDeAtributos y armarCsv', () => {
    it('no repite las columnas fijas', () => {
        expect(columnasDeAtributos([{ name: 'color_80' }, { name: 'marca' }, { name: 'price' }, { name: 'color_80' }])).toEqual(['color_80']);
    });

    it('arma el CSV con el encabezado de la plantilla, «;» y las celdas con comillas o saltos de línea entrecomilladas', () => {
        const atributos = columnasDeAtributos(CAMPOS);
        const { csv, columnas } = armarCsv([filaDeRipley(lonchera(), atributos)], atributos);
        const [encabezado, datos] = csv.split('\r\n');
        expect(encabezado).toBe(columnas.join(';'));
        expect(columnas.slice(0, COLUMNAS_ANTES.length)).toEqual(COLUMNAS_ANTES);
        expect(columnas.slice(-COLUMNAS_DESPUES.length)).toEqual(COLUMNAS_DESPUES);
        // La descripción trae comillas y «;»: va entrecomillada con las comillas duplicadas.
        expect(datos).toContain('"<p>Lonchera ""térmica""; con cierre</p>"');
        expect(csv.endsWith('\r\n')).toBe(true);
    });

    it('todas las filas tienen tantas celdas como columnas', () => {
        const atributos = columnasDeAtributos(CAMPOS);
        const { csv, columnas } = armarCsv([filaDeRipley(lonchera(), atributos), filaDeRipley(lonchera({ sku: 'BP000008', descripcion: 'Descripción simple', atributos: { color_80: 'Negro' } }), atributos)], atributos);
        const filas = csv.trim().split('\r\n').slice(1);
        expect(filas).toHaveLength(2);
        // Sin celdas entrecomilladas con «;» dentro de la segunda fila, así que contar separadores es seguro.
        expect(filas[1].split(';')).toHaveLength(columnas.length);
    });
});
