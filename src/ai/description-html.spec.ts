import { elegirImagenes, escaparHtml, extraerUrlsDeImagen, normalizarContenido, quitarUrls, renderDescripcionHtml, textoPlanoDeContenido } from './description-html';

const contenido = () => normalizarContenido({
    title: 'Torre de aprendizaje Montessori de madera',
    intro1: 'Tu peque quiere ayudarte en la cocina.',
    intro2: 'Seguridad y autonomía.',
    benefits: [1, 2, 3, 4].map((n) => ({ subtitle: `Beneficio ${n}`, text: `Texto ${n}`, alt: `Alt ${n}` })),
    why: Array.from({ length: 6 }, (_, i) => ({ feature: `Caract ${i + 1}`, benefit: `Beneficio ${i + 1}` })),
    specs: Array.from({ length: 8 }, (_, i) => ({ label: `Dato ${i + 1}`, value: `Valor ${i + 1}` })),
}, 'Torre')!;

describe('enlaces de imágenes que pasa el cliente', () => {
    it('toma los GIFs e imágenes de la descripción, en orden y sin repetir, y deja fuera otros enlaces', () => {
        const texto = 'Mira https://media.giphy.com/media/abc/giphy.gif y https://x.com/a.png, también https://x.com/a.png y https://tienda.com/producto/123 más https://res.cloudinary.com/demo/video-gif';
        expect(extraerUrlsDeImagen(texto)).toEqual(['https://media.giphy.com/media/abc/giphy.gif', 'https://x.com/a.png', 'https://res.cloudinary.com/demo/video-gif']);
    });

    it('quitarUrls deja solo el texto', () => {
        expect(quitarUrls('Torre azul https://x.com/a.gif de pino')).toBe('Torre azul de pino');
    });
});

describe('qué imágenes lleva la ficha', () => {
    it('primero las del cliente y, si faltan, las fotos del producto', () => {
        expect(elegirImagenes(['https://g/1.gif', 'https://g/2.gif'], ['https://p/1.jpg', 'https://p/2.jpg', 'https://p/3.jpg']))
            .toEqual(['https://g/1.gif', 'https://g/2.gif', 'https://p/1.jpg', 'https://p/2.jpg']);
    });
    it('con menos de 4 en total se repiten, y sin ninguna no hay imágenes', () => {
        expect(elegirImagenes([], ['https://p/1.jpg', 'https://p/2.jpg'])).toEqual(['https://p/1.jpg', 'https://p/2.jpg', 'https://p/1.jpg', 'https://p/2.jpg']);
        expect(elegirImagenes([], [])).toEqual([]);
    });
});

describe('ficha HTML estándar de la agencia', () => {
    it('respeta la estructura de la plantilla: título rojo, 2 filas de 2 beneficios, por qué elegir, especificaciones', () => {
        const html = renderDescripcionHtml(contenido(), ['https://g/1.gif', 'https://g/2.gif', 'https://g/3.gif', 'https://g/4.gif']);
        expect(html).toContain('<h2 style="font-size: 26px; margin: 0 0 15px 0; color: #d32f2f;">Torre de aprendizaje Montessori de madera</h2>');
        expect(html.match(/<img /g)).toHaveLength(4);
        expect(html).toContain('src="https://g/3.gif" alt="Alt 3"');
        expect(html.match(/<h3 style="font-size: 22px;/g)).toHaveLength(4);
        expect(html).toContain('¿Por qué elegir este producto?');
        expect(html).toContain('Especificaciones Técnicas');
        expect(html.match(/<li style="margin-bottom: 15px;">/g)).toHaveLength(6);
        expect(html.match(/<li style="margin-bottom: 12px;">/g)).toHaveLength(8);
        expect(html).toContain('<b>Dato 1:</b> Valor 1');
        expect(html.startsWith('<div style="max-width: 1000px;')).toBe(true);
    });

    it('escapa el texto de la IA y no se rompe si faltan secciones o imágenes', () => {
        const c = normalizarContenido({ title: 'A <b>&</b> B', intro1: 'x "y"', benefits: [{ subtitle: 'S', text: 'T', alt: 'a' }] }, 'N')!;
        const html = renderDescripcionHtml(c, []);
        expect(html).toContain('A &lt;b&gt;&amp;&lt;/b&gt; B');
        expect(html).toContain('x &quot;y&quot;');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('Especificaciones Técnicas');
        expect(escaparHtml(null)).toBe('');
    });

    it('el texto plano para canales sin HTML sale del mismo contenido: introducción, beneficios y datos técnicos, sin etiquetas ni enlaces', () => {
        const c = normalizarContenido({
            title: 'T', intro1: 'Primer párrafo.', intro2: 'Segundo párrafo.',
            benefits: [{ subtitle: 'Seguro', text: 'Madera lisa', alt: 'a' }],
            specs: [{ label: 'Material', value: 'Pino' }],
        }, 'N')!;
        const texto = textoPlanoDeContenido(c);
        expect(texto).toBe('Primer párrafo.\n\nSegundo párrafo.\n\n- Seguro: Madera lisa\n\nDatos técnicos:\n- Material: Pino');
        expect(texto).not.toMatch(/<|>|https?:/);
    });

    it('descarta una respuesta sin contenido útil', () => {
        expect(normalizarContenido(null, 'N')).toBeNull();
        expect(normalizarContenido({ title: 'x' }, 'N')).toBeNull();
    });
});

describe('opciones del grupo en la ficha (medidas, colores)', () => {
    const base = { title: 'T', intro1: 'Hola', intro2: '', benefits: [], why: [], specs: [] };
    const ejes = [{ name: 'Tamaño cama', values: ['1.5 plazas', '2 plazas'] }, { name: 'Color', values: ['Beige', 'Vino'] }];

    it('arma las opciones desde los ejes y pone lo que incluye solo donde el cliente lo dijo', () => {
        const c = normalizarContenido({ ...base, options: [{ value: '2 plazas', includes: '1 sábana, 2 fundas' }, { value: 'Inventado', includes: 'x' }] }, 'N', ejes)!;
        expect(c.opciones).toEqual([
            { eje: 'Tamaño cama', valores: [{ valor: '1.5 plazas', incluye: '' }, { valor: '2 plazas', incluye: '1 sábana, 2 fundas' }] },
            { eje: 'Color', valores: [{ valor: 'Beige', incluye: '' }, { valor: 'Vino', incluye: '' }] },
        ]);
        const html = renderDescripcionHtml(c, []);
        expect(html).toContain('Tamaño cama disponibles');
        expect(html).toContain('<b>2 plazas</b>: 1 sábana, 2 fundas');
        expect(html).toContain('Beige · Vino');
        expect(html).not.toContain('Inventado');
    });

    it('sin ejes (producto simple) no agrega ninguna sección', () => {
        const c = normalizarContenido({ ...base, benefits: [{ subtitle: 'a', text: 'b' }] }, 'N')!;
        expect(c.opciones).toBeUndefined();
        expect(renderDescripcionHtml(c, [])).not.toContain('disponibles');
    });
});
