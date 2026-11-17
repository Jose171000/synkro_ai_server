import { descripcionParaRipley } from './ripley-publicacion.service';

const FICHA = '<div style="max-width: 1000px"><h1>Disco</h1><img src="https://x/a.jpg" /></div>';
const TEXTO_CON_ETIQUETAS = '<p>El <b>disco sólido</b> es ideal</p><ul><li>Capacidad: 500GB</li></ul>';

describe('descripción que va a Ripley', () => {
    it('la ficha HTML estándar gana al texto corto con etiquetas que la IA redactó para Ripley', () => {
        expect(descripcionParaRipley({ descriptionHtml: FICHA, _ia: ['aiTitle', 'descriptionHtml'], ripley: { description: TEXTO_CON_ETIQUETAS } }, {})).toBe(FICHA);
    });

    it('una ficha HTML traída de otro canal (no generada por la IA) no desplaza al HTML propio de Ripley', () => {
        expect(descripcionParaRipley({ descriptionHtml: FICHA, ripley: { description: TEXTO_CON_ETIQUETAS } }, {})).toBe(TEXTO_CON_ETIQUETAS);
    });

    it('sin ficha estándar usa el HTML propio de Ripley', () => {
        expect(descripcionParaRipley({ ripley: { description: TEXTO_CON_ETIQUETAS } }, {})).toBe(TEXTO_CON_ETIQUETAS);
    });

    it('sin nada de Ripley cae al texto del producto', () => {
        expect(descripcionParaRipley({}, { aiDescription: 'Texto de la IA', description: 'Otro' })).toBe('Texto de la IA');
        expect(descripcionParaRipley({}, { description: 'Otro' })).toBe('Otro');
    });

    it('un texto plano de Ripley no desplaza a la ficha estándar', () => {
        expect(descripcionParaRipley({ descriptionHtml: FICHA, _ia: ['descriptionHtml'], ripley: { description: 'solo texto' } }, {})).toBe(FICHA);
    });
});
