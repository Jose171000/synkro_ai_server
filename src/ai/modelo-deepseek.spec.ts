import { modeloDeepseek } from './modelo-deepseek';

describe('modelo de DeepSeek', () => {
    it('sin variable, o vacía, usa deepseek-chat como siempre', () => {
        for (const v of [undefined, '', '   ']) expect(modeloDeepseek(v)).toBe('deepseek-chat');
    });

    it('con la variable usa ese modelo, sin espacios sobrantes', () => {
        expect(modeloDeepseek('deepseek-v4-flash')).toBe('deepseek-v4-flash');
        expect(modeloDeepseek('  deepseek-v4-flash \n')).toBe('deepseek-v4-flash');
    });

    it('lee DEEPSEEK_MODEL cuando no se le pasa nada', () => {
        const antes = process.env.DEEPSEEK_MODEL;
        try {
            process.env.DEEPSEEK_MODEL = 'otro-modelo';
            expect(modeloDeepseek()).toBe('otro-modelo');
            delete process.env.DEEPSEEK_MODEL;
            expect(modeloDeepseek()).toBe('deepseek-chat');
        } finally {
            if (antes === undefined) delete process.env.DEEPSEEK_MODEL; else process.env.DEEPSEEK_MODEL = antes;
        }
    });
});
