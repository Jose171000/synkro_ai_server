import { descripcionDeTexto, descripcionEnTextoPlano, descripcionParaActualizar, sinEnlaces } from './descripcion-meli';

describe('descripción de Mercado Libre en texto plano', () => {
    it('quita etiquetas e imágenes y deja viñetas y saltos de línea', () => {
        const html = '<div><h2>Zapatera</h2><img src="https://x/a.gif"><p>Con 5 cajones &amp; perchero</p><ul><li>Acero</li><li>Plateado</li></ul></div>';
        const texto = descripcionEnTextoPlano(html);
        expect(texto).not.toMatch(/<|>/);
        expect(texto).toContain('Con 5 cajones & perchero');
        expect(texto).toContain('- Acero\n- Plateado');
    });

    it('sin texto propio usa el de la ficha HTML; con texto propio no la toca', () => {
        const html = { descriptionHtml: '<div><p>Proteína de suero</p></div>' };
        expect(descripcionDeTexto({ aiDescription: '', description: '', aiAttributes: html })).toBe('Proteína de suero');
        expect(descripcionDeTexto({ aiDescription: null, description: 'La del cliente', aiAttributes: html })).toBe('La del cliente');
        expect(descripcionDeTexto({ aiDescription: 'La de la IA', description: 'x', aiAttributes: html })).toBe('La de la IA');
        expect(descripcionDeTexto({ aiDescription: null, description: '', aiAttributes: null })).toBe('');
    });

    it('lo que el cliente escribió llega sin enlaces: los GIFs son para la ficha HTML y Mercado Libre no admite enlaces', () => {
        const html = { descriptionHtml: '<div><p>Proteína de suero</p></div>' };
        expect(descripcionDeTexto({ aiDescription: null, description: 'Proteína sabor vainilla\nhttps://gifs.synkroai.com/a/clip-01.gif', aiAttributes: html })).toBe('Proteína sabor vainilla');
        // Si solo eran enlaces no queda nada propio: se usa el texto de la ficha HTML, nunca los enlaces.
        const soloEnlaces = 'https://gifs.synkroai.com/a/clip-01.gif\nhttps://media.falabella.com/falabellaPE/129110721_01';
        expect(descripcionDeTexto({ aiDescription: null, description: soloEnlaces, aiAttributes: html })).toBe('Proteína de suero');
        expect(descripcionDeTexto({ aiDescription: null, description: soloEnlaces, aiAttributes: null })).toBe('');
    });

    it('sinEnlaces conserva los saltos de línea y quita solo las direcciones', () => {
        expect(sinEnlaces('Primera línea\n\nSegunda https://x.com/a.gif línea.\nhttp://y.com/b')).toBe('Primera línea\n\nSegunda línea.');
        expect(sinEnlaces(null)).toBe('');
    });

    it('al actualizar una publicación que ya existe usa la del producto o lo escrito sin enlaces, sin caer a la ficha HTML', () => {
        expect(descripcionParaActualizar({ aiDescription: 'La de la IA', description: 'x https://a.com/b.gif' })).toBe('La de la IA');
        expect(descripcionParaActualizar({ aiDescription: null, description: 'Texto https://a.com/b.gif' })).toBe('Texto');
        expect(descripcionParaActualizar({ aiDescription: null, description: 'https://a.com/b.gif' })).toBe('');
    });

    it('un texto ya plano queda igual y vacío da vacío', () => {
        expect(descripcionEnTextoPlano('Hola mundo')).toBe('Hola mundo');
        expect(descripcionEnTextoPlano(null)).toBe('');
    });
});
