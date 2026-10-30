/**
 * Modelo de DeepSeek que usa toda la IA de texto (variable DEEPSEEK_MODEL).
 *
 * Sin la variable se usa el de siempre. Si DeepSeek retira o renombra ese modelo, se cambia el valor
 * en Railway sin tocar el código.
 */
export const MODELO_DEEPSEEK_POR_DEFECTO = 'deepseek-chat';

export function modeloDeepseek(valor: string | undefined = process.env.DEEPSEEK_MODEL): string {
    const texto = String(valor ?? '').trim();
    return texto || MODELO_DEEPSEEK_POR_DEFECTO;
}
