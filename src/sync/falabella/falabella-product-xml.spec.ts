import {
    buildPriceUpdateXml,
    buildProductFeedXml,
    buildStockUpdateXml,
    cdata,
    chunkProducts,
    escapeXml,
    FalabellaProductInput,
} from './falabella-product-xml';

const OPCIONES = { operatorCode: 'fape' }; // Perú

const producto = (over: Partial<FalabellaProductInput> = {}): FalabellaProductInput => ({
    sellerSku: '119-001-210',
    name: 'Mascarilla Descartable 3PLY',
    description: 'Protege tu salud',
    brand: 'GENERICO',
    primaryCategory: 2804,
    price: 320,
    stock: 10,
    packageWidth: 40,
    packageLength: 50,
    packageHeight: 30,
    packageWeight: 3,
    ...over,
});

describe('XML de productos para Falabella', () => {
    it('envuelve el lote en Request y un Product por producto', () => {
        const xml = buildProductFeedXml([producto(), producto({ sellerSku: 'B' })], OPCIONES);
        expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Request>')).toBe(true);
        expect(xml.endsWith('</Request>')).toBe(true);
        expect(xml.match(/<Product>/g)).toHaveLength(2);
    });

    it('usa el código de operador que se le pasa, no uno fijo', () => {
        // El ejemplo de la documentación trae 'facl' (Chile). Perú es 'fape'
        // y se comprobó en la cuenta real; equivocarlo publica en otro país.
        expect(buildProductFeedXml([producto()], { operatorCode: 'fape' }))
            .toContain('<OperatorCode>fape</OperatorCode>');
        expect(buildProductFeedXml([producto()], { operatorCode: 'facl' }))
            .toContain('<OperatorCode>facl</OperatorCode>');
    });

    it('manda el precio con dos decimales y el stock entero', () => {
        const xml = buildProductFeedXml([producto({ price: 320, stock: 10.7 })], OPCIONES);
        expect(xml).toContain('<Price>320.00</Price>');
        expect(xml).toContain('<Stock>10</Stock>');
    });

    it('nunca manda stock negativo', () => {
        const xml = buildProductFeedXml([producto({ stock: -5 })], OPCIONES);
        expect(xml).toContain('<Stock>0</Stock>');
    });

    it('incluye los datos de envío que Falabella exige', () => {
        const xml = buildProductFeedXml([producto()], OPCIONES);
        expect(xml).toContain('<PackageWidth>40</PackageWidth>');
        expect(xml).toContain('<PackageLength>50</PackageLength>');
        expect(xml).toContain('<PackageHeight>30</PackageHeight>');
        expect(xml).toContain('<PackageWeight>3</PackageWeight>');
        expect(xml).toContain('<ConditionType>Nuevo</ConditionType>');
    });

    it('omite las etiquetas vacías en vez de mandarlas en blanco', () => {
        const xml = buildProductFeedXml([producto({ parentSku: undefined, productId: undefined })], OPCIONES);
        expect(xml).not.toContain('<ParentSku>');
        expect(xml).not.toContain('<ProductId>');
    });

    it('incluye ParentSku cuando el producto es una variante', () => {
        const xml = buildProductFeedXml([producto({ parentSku: 'PADRE-1' })], OPCIONES);
        expect(xml).toContain('<ParentSku>PADRE-1</ParentSku>');
    });

    it('añade los atributos propios de la categoría', () => {
        const xml = buildProductFeedXml([producto({
            extraAttributes: { Model: 'NITRILO DIAMANTE', ProductionCountry: 'China', Vacio: '' },
        })], OPCIONES);
        expect(xml).toContain('<Model>NITRILO DIAMANTE</Model>');
        expect(xml).toContain('<ProductionCountry>China</ProductionCountry>');
        expect(xml).not.toContain('<Vacio>');
    });

    describe('caracteres peligrosos', () => {
        it('escapa los que romperían el XML', () => {
            expect(escapeXml('Guantes & "Nitrilo" <talla> \'M\''))
                .toBe('Guantes &amp; &quot;Nitrilo&quot; &lt;talla&gt; &apos;M&apos;');
        });

        it('un nombre con ampersand no rompe el documento', () => {
            const xml = buildProductFeedXml([producto({ name: 'Jabón & Alcohol' })], OPCIONES);
            expect(xml).toContain('<Name>Jabón &amp; Alcohol</Name>');
            expect(xml).not.toContain('<Name>Jabón & Alcohol</Name>');
        });

        it('la descripción va en CDATA para conservar el HTML', () => {
            const xml = buildProductFeedXml([producto({ description: '<p>Texto <b>en negrita</b></p>' })], OPCIONES);
            expect(xml).toContain('<Description><![CDATA[<p>Texto <b>en negrita</b></p>]]></Description>');
        });

        it('una descripción que contenga ]]> no cierra el CDATA antes de tiempo', () => {
            // Sin esto, el resto del XML se convertiría en texto suelto y
            // Falabella rechazaría el lote entero con un error de formato.
            const salida = cdata('malicioso ]]> resto');
            expect(salida.startsWith('<![CDATA[')).toBe(true);
            expect(salida.endsWith(']]>')).toBe(true);
            expect(salida).toBe('<![CDATA[malicioso ]]]]><![CDATA[> resto]]>');
        });
    });

    describe('lotes', () => {
        it('parte una lista larga en lotes del tamaño pedido', () => {
            const lotes = chunkProducts(Array.from({ length: 1250 }, (_, i) => i), 500);
            expect(lotes.map(l => l.length)).toEqual([500, 500, 250]);
        });

        it('una lista corta cabe en un solo lote', () => {
            expect(chunkProducts([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
        });

        it('una lista vacía no produce lotes', () => {
            expect(chunkProducts([], 500)).toEqual([]);
        });
    });
});

describe('XML de actualización de precio y stock', () => {
    it('el precio va en la unidad de negocio con el operador y dos decimales', () => {
        const xml = buildPriceUpdateXml([{ sellerSku: 'A-1', price: 79.9 }], OPCIONES);
        expect(xml).toContain('<SellerSku>A-1</SellerSku>');
        expect(xml).toContain('<BusinessUnit><OperatorCode>fape</OperatorCode><Price>79.90</Price></BusinessUnit>');
        expect(xml).not.toContain('<Stock>');
    });

    it('el stock se manda entero y nunca negativo', () => {
        const xml = buildStockUpdateXml(
            [{ sellerSku: 'A-1', quantity: 7.9 }, { sellerSku: 'B', quantity: -3 }],
        );
        expect(xml.match(/<Stock>/g)).toHaveLength(2);
        expect(xml).toContain('<Quantity>7</Quantity>');
        expect(xml).toContain('<Quantity>0</Quantity>');
        expect(xml).not.toContain('<Price>');
    });

    it('usa el formato oficial de UpdateStock: Warehouse > Stock > SellerSku + Quantity', () => {
        expect(buildStockUpdateXml([{ sellerSku: '177-001-316', quantity: 20 }])).toBe(
            '<?xml version="1.0" encoding="UTF-8"?><Request><Warehouse><Stock><SellerSku>177-001-316</SellerSku><Quantity>20</Quantity></Stock></Warehouse></Request>',
        );
    });

    it('escapa el SKU para no romper el XML', () => {
        expect(buildStockUpdateXml([{ sellerSku: 'A&B', quantity: 1 }])).toContain('A&amp;B');
    });
});

describe('fotos de las fichas (acción Image)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildImageFeedXml } = require('./falabella-product-xml');

    it('agrupa las fotos por SKU, escapa el texto y descarta lo que no es una dirección web', () => {
        const xml = buildImageFeedXml([
            { sellerSku: 'A&B-1', urls: ['https://x.com/a.jpg?x=1&y=2', 'no-es-url', 'http://x.com/b.jpg'] },
        ]);
        expect(xml).toContain('<ProductImage>');
        expect(xml).toContain('A&amp;B-1');
        expect(xml.match(/<Image>/g)).toHaveLength(2);
        expect(xml).toContain('x=1&amp;y=2');
        expect(xml).not.toContain('no-es-url');
    });

    it('manda como máximo 8 fotos por producto', () => {
        const urls = Array.from({ length: 12 }, (_, i) => `https://x.com/${i}.jpg`);
        expect(buildImageFeedXml([{ sellerSku: 'S', urls }]).match(/<Image>/g)).toHaveLength(8);
    });
});

describe('actualizar el contenido de una ficha publicada (ProductUpdate)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildContentUpdateXml } = require('./falabella-product-xml');

    it('lleva nombre, descripción en CDATA, marca y atributos, y no toca precio, stock ni categoría', () => {
        const xml = buildContentUpdateXml([{
            sellerSku: 'MK-1', name: 'Torre Montessori', description: '<div>ficha ]]> html</div>', brand: 'GENERICO', primaryCategory: 956,
            price: 480, stock: 10, packageWidth: 45, packageLength: 40, packageHeight: 90, packageWeight: 9,
            extraAttributes: { Material: 'Madera', GrupoDeEdad: '2 - 3 años' },
        }]);
        expect(xml).toContain('<SellerSku>MK-1</SellerSku>');
        expect(xml).toContain('<Name>Torre Montessori</Name>');
        expect(xml).toContain('<![CDATA[<div>ficha ]]]]><![CDATA[> html</div>]]>');
        expect(xml).toContain('<Brand>GENERICO</Brand>');
        expect(xml).toContain('<Material>Madera</Material>');
        expect(xml).toContain('<GrupoDeEdad>2 - 3 años</GrupoDeEdad>');
        expect(xml).toContain('<BusinessUnits><BusinessUnit><OperatorCode>fape</OperatorCode><Price>480.00</Price></BusinessUnit></BusinessUnits>');
        expect(xml).not.toContain('<Stock>');
        expect(xml).not.toContain('PrimaryCategory');
    });
});

describe('precio con descuento y fechas en la unidad de negocio', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildProductFeedXml, buildPriceUpdateXml, buildContentUpdateXml, promocionValida } = require('./falabella-product-xml');
    const base = { sellerSku: 'MK-1', name: 'Torre', description: 'x', brand: 'GENERICO', primaryCategory: 1, price: 400, stock: 3, packageWidth: 1, packageLength: 1, packageHeight: 1, packageWeight: 1 };

    it('el alta lleva SpecialPrice y las fechas cuando la promoción es válida', () => {
        const xml = buildProductFeedXml([{ ...base, salePrice: 320, saleStart: '2026-11-01', saleEnd: '2026-11-30' }], { operatorCode: 'fape' });
        expect(xml).toContain('<Price>400.00</Price><SpecialPrice>320.00</SpecialPrice><SpecialFromDate>2026-11-01</SpecialFromDate><SpecialToDate>2026-11-30</SpecialToDate>');
    });

    it('sin promoción, o con un descuento que no es menor que el precio, no se manda nada', () => {
        expect(buildProductFeedXml([base], { operatorCode: 'fape' })).not.toContain('SpecialPrice');
        expect(buildProductFeedXml([{ ...base, salePrice: 400 }], { operatorCode: 'fape' })).not.toContain('SpecialPrice');
        expect(buildProductFeedXml([{ ...base, salePrice: 500 }], { operatorCode: 'fape' })).not.toContain('SpecialPrice');
    });

    it('el cambio de precio y la actualización de contenido también llevan la promoción', () => {
        const precio = buildPriceUpdateXml([{ sellerSku: 'MK-1', price: 400, salePrice: 300, saleStart: '2026-11-01', saleEnd: null }], { operatorCode: 'fape' });
        expect(precio).toContain('<SpecialPrice>300.00</SpecialPrice><SpecialFromDate>2026-11-01</SpecialFromDate>');
        expect(precio).not.toContain('SpecialToDate');
        expect(buildContentUpdateXml([{ ...base, salePrice: 300 }])).toContain('<SpecialPrice>300.00</SpecialPrice>');
    });

    it('rechaza fechas en desorden y acepta fechas ISO completas', () => {
        expect(promocionValida(400, { salePrice: 300, saleStart: '2026-12-01', saleEnd: '2026-11-01' })).toBeNull();
        expect(promocionValida(400, { salePrice: 300, saleStart: '2026-11-01T05:00:00.000Z' })).toEqual({ salePrice: 300, start: '2026-11-01', end: null });
    });
});

describe('fotos dentro del alta (experimento, apagado por defecto)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildProductFeedXml } = require('./falabella-product-xml');
    const base = { sellerSku: 'MK-1', name: 'Torre', description: 'x', brand: 'GENERICO', primaryCategory: 1, price: 400, stock: 3, packageWidth: 1, packageLength: 1, packageHeight: 1, packageWeight: 1, images: ['https://i/1.jpg', 'ftp://malo/2.jpg', 'https://i/3.jpg?a=1&b=2'] };

    it('sin la opción, el alta no lleva fotos', () => {
        expect(buildProductFeedXml([base], { operatorCode: 'fape' })).not.toContain('<Images>');
    });

    it('con la opción lleva solo las fotos https, escapadas', () => {
        const xml = buildProductFeedXml([base], { operatorCode: 'fape', includeImages: true });
        expect(xml).toContain('<Images><Image>https://i/1.jpg</Image><Image>https://i/3.jpg?a=1&amp;b=2</Image></Images>');
        expect(xml).not.toContain('ftp://');
    });
});
