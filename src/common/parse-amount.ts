/**
 * Interpreta importes tal como se escriben en una hoja de cálculo:
 * "S/ 3,500", "12.000,50", "8000", "$1,234.56".
 *
 * Lo delicado es distinguir el separador de miles del decimal: si se
 * tratan igual, "3,500" acaba valiendo 3.5. Como de estos montos salen
 * las comisiones que se facturan, el error no sería cosmético.
 */
export function parseAmount(value?: string | number | null): number | undefined {
    if (value === null || value === undefined || value === '') return undefined;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;

    let cleaned = String(value).replace(/[^0-9.,-]/g, '').trim();
    if (!cleaned) return undefined;

    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');

    if (lastComma !== -1 && lastDot !== -1) {
        // Conviven ambos: el último es el decimal ("1.234,56" o "1,234.56")
        const decimalSep = lastComma > lastDot ? ',' : '.';
        const thousandSep = decimalSep === ',' ? '.' : ',';
        cleaned = cleaned.split(thousandSep).join('');
        cleaned = cleaned.replace(decimalSep, '.');
    } else if (lastComma !== -1 || lastDot !== -1) {
        const sep = lastComma !== -1 ? ',' : '.';
        const pos = lastComma !== -1 ? lastComma : lastDot;
        const decimals = cleaned.length - pos - 1;
        const occurrences = cleaned.split(sep).length - 1;

        // Un único separador con 3 dígitos detrás ("3,500") son miles;
        // varios separadores ("1.234.567") también.
        if (occurrences > 1 || decimals === 3) {
            cleaned = cleaned.split(sep).join('');
        } else {
            cleaned = cleaned.replace(sep, '.');
        }
    }

    const num = Number(cleaned);
    return Number.isFinite(num) ? num : undefined;
}
