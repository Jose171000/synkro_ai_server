import { descripcionDeTexto, descripcionEnTextoPlano } from './descripcion-meli';

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

    it('un texto ya plano queda igual y vacío da vacío', () => {
        expect(descripcionEnTextoPlano('Hola mundo')).toBe('Hola mundo');
        expect(descripcionEnTextoPlano(null)).toBe('');
    });
});
