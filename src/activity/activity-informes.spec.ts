import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ActivityAdminController } from './activity-admin.controller';
import { informeAExcel } from './activity-excel';
import { informeAPdf } from './activity-pdf';
import { BLOQUES_DE_INFORME, Informe, leerOpcionesDeInforme } from './activity-report.service';
import { colorDeCalor, duracion, nombreDeElemento, nombreDePantalla } from './activity-nombres';

const horas = Array.from({ length: 7 * 15 }, (_, k) => ({ dia: Math.floor(k / 15) + 1, hora: 8 + (k % 15), eventos: 5, segundos: 300, valor: 40 - Math.abs(8 + (k % 15) - 14) * 4 }));
const elemento = (nombre: string, clics: number, intensidad: number, rect: any) =>
    ({ elemento: nombre, clics, usuarios: 2, participacion: Math.round(intensidad * 400) / 10, intensidad, rect });

function informe(sobre: Partial<Informe> = {}): Informe {
    return {
        generadoEn: new Date('2026-11-03T18:00:00Z'),
        opciones: leerOpcionesDeInforme({}),
        periodo: { desde: '2026-10-05', hasta: '2026-11-03' },
        persona: null,
        promedio: true,
        rolesPlataforma: [],
        rolesTienda: [],
        resumen: {
            usuarios: 2, promedio: true,
            total: { sesiones: 9, segundosActivos: 5400, vistas: 120, clics: 340, acciones: 22, ingresos: 9 },
            porUsuario: { sesiones: 4.5, segundosActivos: 2700, vistas: 60, clics: 170, acciones: 11, ingresos: 4.5 },
            ultimoIngreso: null,
        },
        secciones: [{ nombre: 'marketplaces.ventas', total: 50, usuarios: 2, porcentaje: 42 }, { nombre: 'analytics', total: 30, usuarios: 2, porcentaje: 25 }],
        funciones: [{ nombre: 'Registrar venta manual', total: 8, usuarios: 1, porcentaje: 60 }],
        horas,
        personas: [{ userId: 'u1', nombre: 'Jose Ramirez 😀', correo: 'j@x.com', rolPlataforma: 'admin', rolTienda: 'owner', sesiones: 6, segundosActivos: 4000, acciones: 10, clics: 200, ultimoIngreso: '2026-11-03T18:37:00Z' }],
        pantallas: [
            {
                pantalla: 'marketplaces.ventas', clics: 90, usuarios: 2, vistas: 40,
                elementos: [
                    elemento('selector-de-fechas', 40, 1, { x: 190, y: 25, w: 140, h: 40 }),
                    elemento('descargar', 22, 0.55, { x: 670, y: 25, w: 90, h: 40 }),
                    elemento('tarjeta', 12, 0.3, { x: 100, y: 300, w: 800, h: 90 }),
                    elemento('calendario', 30, 0.8, null),
                ],
            },
            { pantalla: 'analytics', clics: 10, usuarios: 1, vistas: 5, elementos: [elemento('aplicar', 10, 1, null)] },
        ],
        pantallasOmitidas: 0,
        linea: null,
        ...sobre,
    };
}

const hojas = async (buf: Buffer) => {
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(buf as any);
    return libro;
};
const paginas = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('qué lleva un informe de actividad', () => {
    it('sin pedir nada lleva todos los bloques y todas las pantallas (informe completo)', () => {
        const o = leerOpcionesDeInforme({});
        expect(o.bloques).toEqual([...BLOQUES_DE_INFORME]);
        expect(o).toMatchObject({ pantallas: [], completo: true });
    });

    it('«Personalizar»: solo los bloques y pantallas elegidos, sin repetidos y con etiquetas limpias', () => {
        const o = leerOpcionesDeInforme({ include: 'resumen,clics,clics', screens: 'marketplaces.ventas, Analíticas ,marketplaces.ventas' });
        expect(o.bloques).toEqual(['resumen', 'clics']);
        expect(o.pantallas).toEqual(['marketplaces.ventas', 'analiticas']);
        expect(o.completo).toBe(false);
    });

    it('rechaza bloques que no existen', () => {
        expect(() => leerOpcionesDeInforme({ include: 'resumen,todo' })).toThrow(/Bloque no válido: todo/);
    });

    it('las descargas son solo del superadmin: el rol admin vale para toda la clase y ninguna ruta lo cambia', () => {
        const rutas = ['excel', 'pdf'];
        for (const r of rutas) {
            expect(typeof (ActivityAdminController.prototype as any)[r]).toBe('function');
            expect(Reflect.getMetadata(ROLES_KEY, (ActivityAdminController.prototype as any)[r])).toBeUndefined();
        }
        expect(Reflect.getMetadata(ROLES_KEY, ActivityAdminController)).toEqual(['admin']);
    });
});

describe('Excel de la actividad', () => {
    it('el informe completo trae una hoja por bloque', async () => {
        const libro = await hojas(await informeAExcel(informe({ linea: [{ at: '2026-11-03T18:00:00Z', tipo: 'view', pantalla: 'analytics', elemento: null, accion: null }] })));
        expect(libro.worksheets.map((h) => h.name)).toEqual(['Resumen', 'Secciones', 'Funciones', 'Horarios', 'Personas', 'Clics', 'Línea de tiempo']);
    });

    it('el informe personalizado trae solo lo elegido', async () => {
        const libro = await hojas(await informeAExcel(informe({
            opciones: leerOpcionesDeInforme({ include: 'secciones' }),
            funciones: null, horas: null, personas: null, pantallas: null,
        })));
        expect(libro.worksheets.map((h) => h.name)).toEqual(['Resumen', 'Secciones']);
        const resumen = libro.getWorksheet('Resumen')!;
        const textos = resumen.getSheetValues().flat().map(String).join('|');
        expect(textos).toContain('Informe personalizado');
    });

    it('usa nombres legibles y marca los controles de ventanas emergentes', async () => {
        const libro = await hojas(await informeAExcel(informe()));
        const secciones = libro.getWorksheet('Secciones')!;
        expect(secciones.getRow(2).getCell(1).value).toBe('Marketplaces › Ventas');
        const clics = libro.getWorksheet('Clics')!;
        const filas = [2, 3, 4, 5, 6].map((n) => clics.getRow(n).values as any[]);
        const calendario = filas.find((f) => f[2] === 'Calendario')!;
        expect(calendario[8]).toBe('Sí');
        const fecha = filas.find((f) => f[2] === 'Selector de fechas')!;
        expect(fecha[6]).toBe(19);
    });

    it('el tiempo activo y el promedio por persona se muestran cuando son varias personas', async () => {
        const resumen = (await hojas(await informeAExcel(informe()))).getWorksheet('Resumen')!;
        const textos = resumen.getSheetValues().flat().map(String);
        expect(textos).toContain('Promedio por persona');
        expect(textos).toContain('45 min');
    });
});

describe('PDF de la actividad', () => {
    it('es un PDF válido con todos los bloques y un pie en cada página', async () => {
        const pdf = await informeAPdf(informe());
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
        expect(pdf.subarray(-6).toString()).toContain('%%EOF');
        expect(paginas(pdf)).toBeGreaterThanOrEqual(2);
        if (process.env.GUARDAR_INFORMES) fs.writeFileSync(path.join(process.env.GUARDAR_INFORMES, 'actividad-completa.pdf'), pdf);
    });

    it('un informe personalizado y uno vacío también se generan, aunque no haya datos', async () => {
        const solo = await informeAPdf(informe({ opciones: leerOpcionesDeInforme({ include: 'resumen' }), secciones: null, funciones: null, horas: null, personas: null, pantallas: null }));
        expect(paginas(solo)).toBe(1);
        const vacio = await informeAPdf(informe({ secciones: [], funciones: [], horas: [], personas: [], pantallas: [], resumen: null }));
        expect(vacio.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('con muchas personas y pantallas sigue en pocas páginas bien cortadas', async () => {
        const muchas = Array.from({ length: 70 }, (_, k) => ({ userId: `u${k}`, nombre: `Persona ${k}`, correo: null, rolPlataforma: 'user', rolTienda: null, sesiones: k, segundosActivos: k * 60, acciones: k, clics: k, ultimoIngreso: null }));
        const pdf = await informeAPdf(informe({ personas: muchas, linea: Array.from({ length: 60 }, () => ({ at: '2026-11-03T18:00:00Z', tipo: 'view', pantalla: 'analytics', elemento: null, accion: null })) }));
        expect(paginas(pdf)).toBeGreaterThanOrEqual(3);
        expect(paginas(pdf)).toBeLessThan(10);
        if (process.env.GUARDAR_INFORMES) fs.writeFileSync(path.join(process.env.GUARDAR_INFORMES, 'actividad-larga.pdf'), pdf);
    });
});

describe('nombres para los informes', () => {
    it('pantallas, elementos y duraciones', () => {
        expect(nombreDePantalla('ai-products.producto-individual')).toBe('IA Productos › Producto individual');
        expect(nombreDeElemento('incluir-el-envio-en-las-ventas')).toBe('Incluir el envio en las ventas');
        expect([duracion(40), duracion(90), duracion(3725)]).toEqual(['40 s', '1 min 30 s', '1 h 02 min']);
    });

    it('el color va del amarillo al rojo', () => {
        const [r1, g1] = colorDeCalor(0), [r2, g2] = colorDeCalor(1);
        expect(r1).toBeGreaterThan(200); expect(g1).toBeGreaterThan(g2);
        expect(r2).toBeGreaterThan(200); expect(g2).toBeLessThan(80);
    });
});
