import * as ExcelJS from 'exceljs';
import { Informe } from './activity-report.service';
import { colorDeCalor, duracion, franjaHoraria, nombreDeDia, nombreDeElemento, nombreDePantalla } from './activity-nombres';

const AMARILLO = 'FFFCCB34';
const GRIS = 'FFF3F3F3';
const hex = ([r, g, b]: [number, number, number]) => `FF${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

function encabezado(hoja: ExcelJS.Worksheet, columnas: { titulo: string; ancho: number; formato?: string }[]) {
    hoja.columns = columnas.map((c) => ({ width: c.ancho, style: c.formato ? { numFmt: c.formato } : {} }));
    const fila = hoja.addRow(columnas.map((c) => c.titulo));
    fila.font = { bold: true };
    fila.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMARILLO } }; });
    hoja.views = [{ state: 'frozen', ySplit: 1 }];
}

const periodo = (i: Informe) => (i.periodo.desde === i.periodo.hasta ? i.periodo.desde : `${i.periodo.desde} al ${i.periodo.hasta}`);

/** Excel del informe de actividad: una hoja por bloque, solo con lo que el informe trae. */
export async function informeAExcel(i: Informe): Promise<Buffer> {
    const libro = new ExcelJS.Workbook();
    libro.creator = 'Synkro AI';
    libro.created = i.generadoEn;

    // ── Resumen ──
    const res = libro.addWorksheet('Resumen');
    res.columns = [{ width: 34 }, { width: 22 }, { width: 22 }];
    res.addRow(['Actividad de los usuarios - Synkro']).font = { bold: true, size: 14 };
    res.addRow([]);
    const dato = (k: string, v: string) => { const f = res.addRow([k, v]); f.getCell(1).font = { bold: true }; };
    dato('Periodo (hora de Lima)', periodo(i));
    dato('Persona', i.persona ?? 'Todas las personas');
    if (!i.persona) dato('Cómo se mide', i.promedio ? 'Promedio por persona' : 'Suma de todas las personas');
    dato('Rol en la plataforma', i.rolesPlataforma.length ? i.rolesPlataforma.join(', ') : 'Todos');
    dato('Rol dentro de la tienda', i.rolesTienda.length ? i.rolesTienda.join(', ') : 'Todos');
    dato('Generado', i.generadoEn.toLocaleString('es-PE', { timeZone: 'America/Lima' }));
    dato('Contenido', i.opciones.completo ? 'Informe completo' : 'Informe personalizado');
    if (i.resumen) {
        res.addRow([]);
        const cab = res.addRow(['Indicador', 'Total', i.resumen.promedio && i.resumen.usuarios > 1 ? 'Por persona (promedio)' : '']);
        cab.font = { bold: true };
        cab.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMARILLO } }; });
        const t = i.resumen.total, p = i.resumen.porUsuario;
        const mostrarPromedio = i.resumen.promedio && i.resumen.usuarios > 1;
        const kpi = (nombre: string, total: number, porPersona: number, esTiempo = false) =>
            res.addRow([nombre, esTiempo ? duracion(total) : total, mostrarPromedio ? (esTiempo ? duracion(porPersona) : porPersona) : '']);
        res.addRow(['Personas con actividad', i.resumen.usuarios, '']);
        kpi('Sesiones', t.sesiones, p.sesiones);
        kpi('Tiempo activo', t.segundosActivos, p.segundosActivos, true);
        kpi('Pantallas abiertas', t.vistas, p.vistas);
        kpi('Clics', t.clics, p.clics);
        kpi('Acciones', t.acciones, p.acciones);
        kpi('Ingresos', t.ingresos, p.ingresos);
    }
    res.addRow([]);
    const nota = res.addRow(['Información confidencial: solo para superadmins. Se registra únicamente a quienes aceptaron el aviso de privacidad; no se guarda lo que se escribe, contraseñas ni datos de clientes finales.']);
    nota.font = { italic: true, color: { argb: 'FF666666' } };

    // ── Rankings ──
    const ranking = (nombre: string, titulo: string, datos: NonNullable<Informe['secciones']>, nombrar: (t: string) => string) => {
        const h = libro.addWorksheet(nombre);
        encabezado(h, [{ titulo, ancho: 42 }, { titulo: 'Veces', ancho: 12 }, { titulo: 'Personas', ancho: 12 }, { titulo: i.promedio ? '% del uso de cada persona (promedio)' : '% respecto al mayor', ancho: 36, formato: '0.0%' }]);
        for (const x of datos) h.addRow([nombrar(x.nombre), x.total, x.usuarios, x.porcentaje / 100]);
    };
    if (i.secciones) ranking('Secciones', 'Sección', i.secciones, nombreDePantalla);
    if (i.funciones) ranking('Funciones', 'Función', i.funciones, nombreDeElemento);

    // ── Horarios: días en filas, horas en columnas ──
    if (i.horas) {
        const h = libro.addWorksheet('Horarios');
        encabezado(h, [{ titulo: 'Día \\ Hora (Lima)', ancho: 18 }, ...Array.from({ length: 24 }, (_, k) => ({ titulo: String(k).padStart(2, '0'), ancho: 6 }))]);
        const mapa = new Map(i.horas.map((c) => [`${c.dia}-${c.hora}`, c]));
        const max = Math.max(0, ...i.horas.map((c) => c.valor));
        for (let d = 1; d <= 7; d++) {
            const fila = h.addRow([nombreDeDia(d), ...Array.from({ length: 24 }, (_, k) => mapa.get(`${d}-${k}`)?.valor ?? 0)]);
            fila.getCell(1).font = { bold: true };
            for (let k = 0; k < 24; k++) {
                const v = mapa.get(`${d}-${k}`)?.valor ?? 0;
                const celda = fila.getCell(k + 2);
                celda.alignment = { horizontal: 'center' };
                if (v > 0 && max > 0) celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hex(colorDeCalor(v / max)) } };
            }
        }
        h.addRow([]);
        h.addRow([`Movimiento (pantallas, clics y acciones)${i.promedio ? ' por persona' : ''}. Horas más activas:`]).font = { italic: true };
        const porHora = Array.from({ length: 24 }, (_, k) => ({ k, v: [1, 2, 3, 4, 5, 6, 7].reduce((s, d) => s + (mapa.get(`${d}-${k}`)?.valor ?? 0), 0) }))
            .sort((a, b) => b.v - a.v).slice(0, 3).filter((x) => x.v > 0);
        for (const x of porHora) h.addRow([franjaHoraria(x.k)]);
    }

    // ── Personas ──
    if (i.personas) {
        const h = libro.addWorksheet('Personas');
        encabezado(h, [
            { titulo: 'Persona', ancho: 30 }, { titulo: 'Correo', ancho: 32 }, { titulo: 'Rol en la plataforma', ancho: 20 }, { titulo: 'Rol en la tienda', ancho: 16 },
            { titulo: 'Sesiones', ancho: 10 }, { titulo: 'Tiempo activo', ancho: 16 }, { titulo: 'Clics', ancho: 10 }, { titulo: 'Acciones', ancho: 10 }, { titulo: 'Última vez', ancho: 20 },
        ]);
        for (const p of i.personas) {
            h.addRow([
                p.nombre, p.correo ?? '', p.rolPlataforma ?? '', p.rolTienda ?? '', p.sesiones, duracion(p.segundosActivos), p.clics, p.acciones,
                p.ultimoIngreso ? new Date(p.ultimoIngreso).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '',
            ]);
        }
    }

    // ── Clics: todas las pantallas elegidas, una fila por elemento ──
    if (i.pantallas) {
        const h = libro.addWorksheet('Clics');
        encabezado(h, [
            { titulo: 'Pantalla', ancho: 34 }, { titulo: 'Elemento', ancho: 36 }, { titulo: 'Clics', ancho: 10 }, { titulo: 'Personas', ancho: 10 },
            { titulo: '% de los clics (promedio por persona)', ancho: 24, formato: '0.0%' }, { titulo: 'Posición horizontal (0-100)', ancho: 18 }, { titulo: 'Posición vertical (0-100)', ancho: 18 }, { titulo: 'Ventana emergente', ancho: 16 },
        ]);
        for (const p of i.pantallas) {
            for (const e of p.elementos) {
                h.addRow([
                    nombreDePantalla(p.pantalla), nombreDeElemento(e.elemento), e.clics, e.usuarios, e.participacion / 100,
                    e.rect?.x != null ? Math.round(e.rect.x / 10) : '', e.rect?.y != null ? Math.round(e.rect.y / 10) : '', e.rect ? '' : 'Sí',
                ]);
            }
        }
        if (i.pantallasOmitidas > 0) h.addRow([`Faltan ${i.pantallasOmitidas} pantallas con menos clics: elige pantallas concretas con «Personalizar».`]).font = { italic: true };
    }

    // ── Línea de tiempo de una persona ──
    if (i.linea) {
        const h = libro.addWorksheet('Línea de tiempo');
        encabezado(h, [{ titulo: 'Cuándo (Lima)', ancho: 22 }, { titulo: 'Qué hizo', ancho: 16 }, { titulo: 'Dónde / qué', ancho: 46 }]);
        const verbo: Record<string, string> = { view: 'Abrió', action: 'Hizo', login: 'Ingresó' };
        for (const e of i.linea) {
            h.addRow([
                new Date(e.at).toLocaleString('es-PE', { timeZone: 'America/Lima' }),
                verbo[e.tipo] ?? e.tipo,
                e.tipo === 'action' ? nombreDeElemento(e.accion ?? e.elemento ?? '') : e.tipo === 'login' ? 'La plataforma' : nombreDePantalla(e.pantalla),
            ]);
        }
    }

    libro.eachSheet((h) => h.eachRow((fila, n) => { if (n > 1 && n % 2 === 0 && h.name !== 'Horarios' && h.name !== 'Resumen') fila.eachCell((c) => { if (!c.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS } }; }); }));

    return Buffer.from(await libro.xlsx.writeBuffer());
}
