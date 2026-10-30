import { createHash } from 'crypto';
import { MAX_IMAGES } from './product-vision.service';

/**
 * Qué fotos vio la IA al analizar un producto. Se guarda junto a la visión (aiAttributes._visionFotos) para saber si
 * sigue valiendo o si las fotos cambiaron desde entonces. Solo cuentan las primeras que se analizan.
 */
export function huellaDeFotos(urls: string[]): string {
    const analizadas = (urls ?? []).filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_IMAGES);
    return createHash('sha1').update(analizadas.join('\n')).digest('hex').slice(0, 12);
}

/**
 * ¿Hay que volver a analizar las fotos? Sí si nunca se analizaron, si cambiaron desde el último análisis, si el producto
 * tiene visión de antes de que se guardara la huella (no se sabe con qué fotos se hizo) o si la persona lo fuerza.
 * Sin fotos analizables no hay nada que analizar: se conserva lo que haya.
 */
export function necesitaVision(atributos: Record<string, any> | null | undefined, urls: string[], forzar = false): boolean {
    const hayFotos = (urls ?? []).some((u) => /^https?:\/\//i.test(u));
    if (!hayFotos) return false;
    if (forzar || !atributos?.vision) return true;
    return atributos._visionFotos !== huellaDeFotos(urls);
}
