/**
 * Un atributo puede estar guardado con varias escrituras del mismo nombre (`Gramaje`, `gramaje`, `gramaje_`): al leerlo se toma la primera
 * que coincide. Si al guardar se añadiera la nueva SIN quitar las demás, la persona editaría un valor y seguiría saliendo el viejo.
 * Aquí el valor nuevo reemplaza a todas las escrituras equivalentes. Función pura.
 */
const clave = (texto: string): string => texto.toLowerCase().replace(/[^a-z0-9]/g, '');

export function fusionarAtributos(
    existentes: Record<string, any> | null | undefined,
    nuevos: Record<string, any> | null | undefined,
): Record<string, any> {
    const entrantes = nuevos ?? {};
    const reemplazadas = new Set(Object.keys(entrantes).map(clave));
    const conservados = Object.fromEntries(Object.entries(existentes ?? {}).filter(([k]) => !reemplazadas.has(clave(k))));
    return { ...conservados, ...entrantes };
}
