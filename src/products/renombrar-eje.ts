import { BadRequestException } from '@nestjs/common';
import { EjeDeVariacion } from './entities/product-group.entity';

const limpio = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim();
const clave = (t: unknown) => limpio(t).toLowerCase();

/**
 * Renombra un eje de variación («Talla» → «Tamaño cama»). Solo cambia el NOMBRE: los valores y el orden de los ejes quedan igual.
 * Falla si el eje no existe o si el nombre nuevo ya lo usa otro eje.
 */
export function renombrarEje(ejes: EjeDeVariacion[], desde: string, hasta: string): EjeDeVariacion[] {
    const de = limpio(desde);
    const a = limpio(hasta).slice(0, 60);
    if (!de || !a) throw new BadRequestException('Indica el eje y su nombre nuevo.');
    const actual = ejes.find((e) => clave(e.name) === clave(de));
    if (!actual) throw new BadRequestException(`Este producto no tiene un eje llamado «${de}».`);
    if (clave(a) !== clave(de) && ejes.some((e) => clave(e.name) === clave(a))) throw new BadRequestException(`Ya existe un eje llamado «${a}».`);
    return ejes.map((e) => (e === actual ? { ...e, name: a } : e));
}

/** Los valores de una variante con la clave del eje renombrada, en el mismo orden. */
export function renombrarClaveDeValores(valores: Record<string, string> | null | undefined, desde: string, hasta: string): Record<string, string> | null {
    if (!valores) return null;
    const de = clave(desde);
    const a = limpio(hasta).slice(0, 60);
    return Object.fromEntries(Object.entries(valores).map(([k, v]) => [clave(k) === de ? a : k, v]));
}
