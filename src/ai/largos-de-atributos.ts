import { CategoryAttribute } from '../categories/entities/marketplace-category.entity';
import { recortarTexto } from '../sync/falabella/falabella-fields';

/** La frase que va al prompt cuando el atributo tiene un máximo de caracteres. */
export function notaDeLargo(a: Pick<CategoryAttribute, 'maxLength' | 'options'>): string {
    return a.maxLength && !a.options?.length ? ` — MÁXIMO ${a.maxLength} caracteres (resume sin cortar la idea)` : '';
}

/** Lo que la IA escribió de más se acorta al máximo de cada atributo, sin partir palabras. Cambia el objeto recibido. */
export function acortarALoPermitido(valores: Record<string, any> | null | undefined, atributos: CategoryAttribute[] | null | undefined): void {
    if (!valores) return;
    for (const a of atributos ?? []) {
        const v = valores[a.name];
        if (a.maxLength && !a.options?.length && typeof v === 'string' && v.length > a.maxLength) valores[a.name] = recortarTexto(v, a.maxLength);
    }
}
