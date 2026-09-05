import * as ExcelJS from 'exceljs';

/**
 * Lectura y escritura de hojas de cálculo.
 *
 * Antes esto se hacía con `xlsx` (SheetJS) 0.18.5, la última versión que esa
 * librería publicó en npm. Arrastra dos avisos de seguridad —contaminación de
 * prototipos y una expresión regular que se puede colgar— y justamente se usaba
 * para leer los archivos que suben los usuarios, que es el peor sitio posible.
 *
 * ExcelJS se mantiene, está en npm y además sabe hacer validación de datos
 * (listas desplegables) y proteger hojas, que es lo que necesita la plantilla
 * descargable del módulo de publicaciones.
 */

/** Límite de filas por hoja al leer. Un archivo mayor es casi seguro un error. */
const MAX_FILAS = 50_000;

/**
 * Convierte el valor de una celda en algo simple.
 *
 * ExcelJS no siempre devuelve un dato plano: una celda puede traer texto con
 * formato, una fórmula con su resultado, un hipervínculo o un error. Si eso
 * llega tal cual al resto de la aplicación, acaba guardándose un `[object
 * Object]` en la base de datos.
 */
function valorPlano(valor: ExcelJS.CellValue): any {
    if (valor === null || valor === undefined) return undefined;

    if (valor instanceof Date) return valor;

    if (typeof valor === 'object') {
        const v = valor as any;

        // Fórmula: interesa el resultado calculado, no la fórmula.
        if ('result' in v) return valorPlano(v.result);

        // Texto con formato (negritas, colores...): se juntan los trozos.
        if ('richText' in v && Array.isArray(v.richText)) {
            return v.richText.map((t: any) => t.text).join('');
        }

        // Celda con hipervínculo: vale más el texto visible que el objeto.
        if ('text' in v) return valorPlano(v.text);

        // Celda con error (#N/A, #REF!...): se trata como vacía.
        if ('error' in v) return undefined;

        if ('hyperlink' in v) return v.hyperlink;
    }

    if (typeof valor === 'string') {
        const limpio = valor.trim();
        return limpio === '' ? undefined : limpio;
    }

    return valor;
}

/**
 * Lee la primera hoja y devuelve una fila por objeto, usando la primera fila
 * como nombres de columna.
 *
 * Mantiene el comportamiento que tenía SheetJS: las filas totalmente vacías se
 * saltan y las celdas vacías no generan clave, para que `if (row.precio)` siga
 * funcionando igual que antes.
 */
export async function leerPrimeraHoja(
    buffer: Buffer,
): Promise<Record<string, any>[]> {
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(buffer as any);

    const hoja = libro.worksheets[0];
    if (!hoja) return [];

    const cabeceras: (string | null)[] = [];
    hoja.getRow(1).eachCell({ includeEmpty: true }, (celda, col) => {
        const nombre = valorPlano(celda.value);
        cabeceras[col] = nombre === undefined ? null : String(nombre).trim();
    });

    if (!cabeceras.some(Boolean)) return [];

    const filas: Record<string, any>[] = [];

    for (let n = 2; n <= hoja.rowCount && filas.length < MAX_FILAS; n++) {
        const fila = hoja.getRow(n);
        const objeto: Record<string, any> = {};
        let tieneAlgo = false;

        for (let col = 1; col < cabeceras.length; col++) {
            const clave = cabeceras[col];
            if (!clave) continue;

            const valor = valorPlano(fila.getCell(col).value);
            if (valor === undefined) continue;

            objeto[clave] = valor;
            tieneAlgo = true;
        }

        if (tieneAlgo) filas.push(objeto);
    }

    return filas;
}

/**
 * Crea un .xlsx de una sola hoja a partir de una lista de objetos.
 * Las columnas se ajustan al contenido para que se pueda leer sin tocar nada.
 */
export async function escribirHoja(
    datos: Record<string, any>[],
    nombreHoja: string,
): Promise<Buffer> {
    const libro = new ExcelJS.Workbook();
    libro.created = new Date();

    // Excel no admite más de 31 caracteres ni los signos \ / ? * [ ] en el
    // nombre de una hoja; con ellos el archivo se abre dañado.
    const nombreValido = (nombreHoja || 'Hoja1')
        .replace(/[\\\/\?\*\[\]:]/g, '-')
        .slice(0, 31) || 'Hoja1';

    const hoja = libro.addWorksheet(nombreValido);

    if (datos.length > 0) {
        const cabeceras = Object.keys(datos[0]);

        hoja.columns = cabeceras.map(cabecera => ({
            header: cabecera,
            key: cabecera,
            width: Math.min(
                datos.reduce(
                    (max, fila) => Math.max(max, String(fila[cabecera] ?? '').length),
                    cabecera.length,
                ) + 2,
                60,
            ),
        }));

        hoja.getRow(1).font = { bold: true };
        for (const fila of datos) hoja.addRow(fila);
    }

    const salida = await libro.xlsx.writeBuffer();
    return Buffer.from(salida);
}
