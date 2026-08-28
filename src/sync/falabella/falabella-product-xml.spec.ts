import {
    buildProductFeedXml,
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
