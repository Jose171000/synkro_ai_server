import { descripcionEnTextoPlano } from './descripcion-meli';

describe('descripción de Mercado Libre en texto plano', () => {
    it('quita etiquetas e imágenes y deja viñetas y saltos de línea', () => {
        const html = '<div><h2>Zapatera</h2><img src="https://x/a.gif"><p>Con 5 cajones &amp; perchero</p><ul><li>Acero</li><li>Plateado</li></ul></div>';
        const texto = descripcionEnTextoPlano(html);
        expect(texto).not.toMatch(/<|>/);
        expect(texto).toContain('Con 5 cajones & perchero');
        expect(texto).toContain('- Acero\n- Plateado');
    });

    it('un texto ya plano queda igual y vacío da vacío', () => {
        expect(descripcionEnTextoPlano('Hola mundo')).toBe('Hola mundo');
        expect(descripcionEnTextoPlano(null)).toBe('');
    });
});
