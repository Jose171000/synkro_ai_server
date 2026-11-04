import PDFDocument = require('pdfkit');
import { Informe } from './activity-report.service';
import { colorDeCalor, duracion, franjaHoraria, nombreDeDia, nombreDeElemento, nombreDePantalla } from './activity-nombres';

const ANCHO = 595.28;
const ALTO = 841.89;
const M = 40;
const UTIL = ANCHO - 2 * M;
const PIE = 30;
const AMARILLO = '#FCCB34';
const TINTA = '#111111';
const GRIS = '#666666';
const SUAVE = '#F4F4F4';

/** Helvetica solo dibuja el alfabeto latino: lo demás (emojis, otros alfabetos) se cambia por «?» para no ensuciar la página. */
const seguro = (t: unknown) => String(t ?? '').replace(/[^\x20-\x7E -ÿ–—‘-”•…›]/g, '?');
const rgb = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const num = (n: number) => Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: 1 });
const cuando = (iso: string | Date | null) => (iso ? new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');
const periodo = (i: Informe) => (i.periodo.desde === i.periodo.hasta ? i.periodo.desde : `${i.periodo.desde} al ${i.periodo.hasta}`);

/**
 * PDF visual del informe de actividad (librería propia, sin servicios externos). Dibuja solo lo que trae el informe: por
 * defecto todo, o lo que el superadmin eligió en «Personalizar».
 */
export function informeAPdf(i: Informe): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4', margin: M, bufferPages: true,
            info: { Title: 'Actividad de los usuarios - Synkro', Author: 'Synkro AI', Subject: 'Informe confidencial para superadmins' },
        });
        const trozos: Buffer[] = [];
        doc.on('data', (t: Buffer) => trozos.push(t));
        doc.on('end', () => resolve(Buffer.concat(trozos)));
        doc.on('error', reject);

        let y = 0;
        const asegurar = (alto: number) => { if (y + alto > ALTO - M - PIE) { doc.addPage(); y = M; } };
        const texto = (t: unknown, x: number, yy: number, o: { w?: number; size?: number; bold?: boolean; color?: string; align?: 'left' | 'right' | 'center' } = {}) => {
            doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size ?? 9).fillColor(o.color ?? TINTA);
            doc.text(seguro(t), x, yy, { width: o.w ?? UTIL, align: o.align ?? 'left', lineBreak: false, ellipsis: true, height: (o.size ?? 9) + 2 });
        };
        const titulo = (t: string, ayuda?: string) => {
            asegurar(ayuda ? 40 : 28);
            texto(t, M, y, { size: 12, bold: true });
            y += 17;
            if (ayuda) { texto(ayuda, M, y, { size: 8, color: GRIS }); y += 14; }
        };

        // ── Cabecera ──
        doc.rect(0, 0, ANCHO, 78).fill(AMARILLO);
        texto('SYNKRO', M, 20, { size: 10, bold: true });
        texto('Actividad de los usuarios', M, 34, { size: 20, bold: true });
        texto(`${periodo(i)} · hora de Lima`, M, 59, { size: 9 });
        y = 96;

        // ── Filtros ──
        const filas: [string, string][] = [
            ['Persona', i.persona ?? 'Todas las personas'],
            ...(!i.persona ? [['Cómo se mide', i.promedio ? 'Promedio por persona' : 'Suma de todas las personas'] as [string, string]] : []),
            ['Rol en la plataforma', i.rolesPlataforma.length ? i.rolesPlataforma.join(', ') : 'Todos'],
            ['Rol dentro de la tienda', i.rolesTienda.length ? i.rolesTienda.join(', ') : 'Todos'],
            ['Generado', i.generadoEn.toLocaleString('es-PE', { timeZone: 'America/Lima' })],
        ];
        for (const [k, v] of filas) { texto(k, M, y, { size: 8.5, color: GRIS, w: 130 }); texto(v, M + 135, y, { size: 8.5, bold: true, w: UTIL - 135 }); y += 13; }
        y += 8;

        // ── Indicadores ──
        if (i.resumen) {
            const r = i.resumen;
            const mostrarPromedio = r.promedio && r.usuarios > 1;
            const v = mostrarPromedio ? r.porUsuario : r.total;
            const tarjetas: [string, string][] = [
                ['Personas con actividad', String(r.usuarios)],
                ['Sesiones', num(v.sesiones)],
                ['Tiempo activo', duracion(v.segundosActivos)],
                ['Pantallas abiertas', num(v.vistas)],
                ['Clics', num(v.clics)],
                ['Acciones', num(v.acciones)],
            ];
            asegurar(120);
            const w = (UTIL - 2 * 10) / 3;
            tarjetas.forEach(([etiqueta, valor], k) => {
                const x = M + (k % 3) * (w + 10), yy = y + Math.floor(k / 3) * 58;
                doc.roundedRect(x, yy, w, 50, 6).fill(SUAVE);
                texto(valor, x + 10, yy + 9, { size: 17, bold: true, w: w - 20 });
                texto(etiqueta + (mostrarPromedio && k > 0 ? ' · por persona' : ''), x + 10, yy + 33, { size: 7.5, color: GRIS, w: w - 20 });
            });
            y += 124;
        }

        // ── Rankings ──
        const ranking = (t: string, ayuda: string, datos: NonNullable<Informe['secciones']>, nombrar: (s: string) => string) => {
            titulo(t, ayuda);
            if (!datos.length) { texto('Sin datos en este periodo.', M, y, { size: 9, color: GRIS }); y += 18; return; }
            for (const d of datos.slice(0, 8)) {
                asegurar(20);
                texto(nombrar(d.nombre), M, y, { w: 200 });
                doc.roundedRect(M + 210, y + 1, 220, 8, 3).fill('#E6E6E6');
                doc.roundedRect(M + 210, y + 1, Math.max(4, Math.min(220, 2.2 * d.porcentaje)), 8, 3).fill(AMARILLO);
                texto(`${num(d.total)} · ${num(d.porcentaje)}%`, M + 436, y, { size: 8.5, color: GRIS, w: UTIL - 436, align: 'right' });
                y += 17;
            }
            y += 10;
        };
        if (i.secciones) ranking('Secciones más usadas', `Pantallas que más se abren${i.promedio ? ' · % = parte del uso de cada persona, en promedio' : ''}`, i.secciones, nombreDePantalla);
        if (i.funciones) ranking('Funciones más usadas', 'Acciones que cambian datos (registrar, editar, subir...)', i.funciones, nombreDeElemento);

        // ── Horarios ──
        if (i.horas) {
            titulo('¿Cuándo usan Synkro?', `Por día de la semana y hora (hora de Lima). Movimiento${i.promedio ? ' por persona' : ''}.`);
            asegurar(7 * 16 + 40);
            const mapa = new Map(i.horas.map((c) => [`${c.dia}-${c.hora}`, c]));
            const max = Math.max(0, ...i.horas.map((c) => c.valor));
            const x0 = M + 36, w = (UTIL - 36) / 24;
            for (let h = 0; h < 24; h += 3) texto(String(h), x0 + h * w, y, { size: 7, color: GRIS, w, align: 'left' });
            y += 11;
            for (let d = 1; d <= 7; d++) {
                texto(nombreDeDia(d).slice(0, 3), M, y + 3, { size: 8, color: GRIS, w: 34 });
                for (let h = 0; h < 24; h++) {
                    const c = mapa.get(`${d}-${h}`);
                    doc.rect(x0 + h * w + 0.7, y, w - 1.4, 13).fill(c && max ? rgb(colorDeCalor(c.valor / max)) : '#EDEDED');
                }
                y += 15;
            }
            const mejores = Array.from({ length: 24 }, (_, h) => ({ h, v: [1, 2, 3, 4, 5, 6, 7].reduce((s, d) => s + (mapa.get(`${d}-${h}`)?.valor ?? 0), 0) }))
                .sort((a, b) => b.v - a.v).slice(0, 3).filter((x) => x.v > 0);
            if (mejores.length) { y += 4; texto(`Horas más activas: ${mejores.map((m) => franjaHoraria(m.h)).join('  ·  ')}`, M, y, { size: 8.5, color: GRIS }); y += 14; }
            y += 10;
        }

        // ── Mapas de clics: un esquema por pantalla ──
        if (i.pantallas) {
            titulo('Mapas de clics', 'Dónde hacen clic dentro de cada pantalla. Es un esquema: cada control en el lugar medio donde se tocó.');
            if (!i.pantallas.length) { texto('Todavía no hay clics registrados con estos filtros.', M, y, { size: 9, color: GRIS }); y += 20; }
            for (const p of i.pantallas) {
                const conPos = p.elementos.flatMap((e) => (e.rect && e.rect.x !== null && e.rect.y !== null && e.rect.w !== null && e.rect.h !== null
                    ? [{ e, x: e.rect.x, y: e.rect.y, w: e.rect.w, h: e.rect.h }] : []));
                const lista = p.elementos.slice(0, 6);
                asegurar(22 + 260 + 12 + lista.length * 12 + 18);
                texto(nombreDePantalla(p.pantalla), M, y, { size: 10.5, bold: true, w: 360 });
                texto(`${num(p.clics)} clics · ${p.usuarios} ${p.usuarios === 1 ? 'persona' : 'personas'}`, M + 360, y, { size: 8.5, color: GRIS, w: UTIL - 360, align: 'right' });
                y += 17;
                // Con el plano de la pantalla, el mapa se dibuja sobre su estructura real y con su proporción.
                const plano = p.plano;
                const alto = plano ? Math.round(Math.min(260, Math.max(120, UTIL * plano.alto / plano.ancho))) : 170;
                asegurar(alto - 170);
                doc.roundedRect(M, y, UTIL, alto, 6).fill(SUAVE);
                if (plano) {
                    for (const b of plano.bloques as { k: string; x: number; y: number; w: number; h: number }[]) {
                        const bx = M + b.x / 1000 * UTIL, by = y + b.y / 1000 * alto, bw = Math.max(1.5, b.w / 1000 * UTIL), bh = Math.max(1.5, b.h / 1000 * alto);
                        doc.save();
                        if (b.k === 'tarjeta' || b.k === 'tabla' || b.k === 'grafico') doc.roundedRect(bx, by, bw, bh, 2).lineWidth(0.6).fillAndStroke('#E9E9E9', '#CFCFCF');
                        else if (b.k === 'campo') doc.roundedRect(bx, by, bw, bh, 1.5).lineWidth(0.5).fillAndStroke('#FFFFFF', '#CFCFCF');
                        else doc.roundedRect(bx, by, bw, bh, 1.5).fill(b.k === 'titulo' ? '#BDBDBD' : '#D5D5D5');
                        doc.restore();
                        if (b.k === 'tabla' || b.k === 'grafico') texto(b.k === 'tabla' ? 'Tabla' : 'Gráfico', bx + 4, by + 3, { size: 6.5, color: '#9A9A9A', w: Math.max(10, bw - 8) });
                    }
                }
                if (!conPos.length) {
                    texto('Los clics de esta pantalla fueron en ventanas emergentes o menús: no tienen posición.', M + 10, y + alto / 2 - 4, { size: 8.5, color: GRIS, w: UTIL - 20, align: 'center' });
                } else {
                    // Sin plano, se estira hacia abajo hasta la zona con clics; con plano, las posiciones son las reales.
                    const alcance = Math.max(0, ...conPos.map((c) => c.y + c.h));
                    const escala = plano ? 1 : alcance > 0 ? Math.min(8, Math.max(1, 1000 / (alcance * 1.15))) : 1;
                    // Zonas de calor: una mancha redonda que se desvanece hacia los bordes (igual que en la pantalla); lo menos tocado
                    // primero, para que donde se mezclan mande la más caliente. Se recorta al marco del mapa.
                    const centros = [...conPos]
                        .sort((a, b) => a.e.intensidad - b.e.intensidad)
                        .map(({ e, x, y: yy, w, h }) => ({
                            e,
                            cx: M + Math.min(1000, Math.max(0, x + w / 2)) / 1000 * UTIL,
                            cy: y + Math.min(1000, Math.max(0, (yy + h / 2) * escala)) / 1000 * alto,
                            r: (14 + 22 * Math.sqrt(e.intensidad)) / 100 * UTIL / 2,
                        }));
                    doc.save().roundedRect(M, y, UTIL, alto, 6).clip();
                    for (const { e, cx, cy, r } of centros) {
                        const color = '#' + colorDeCalor(e.intensidad).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
                        const g = doc.radialGradient(cx, cy, 0, cx, cy, r);
                        g.stop(0, color, 0.9).stop(0.54, color, 0.45).stop(1, color, 0);
                        doc.circle(cx, cy, r).fill(g);
                    }
                    doc.restore();
                    for (const { e, cx, cy } of centros) {
                        texto(String(e.clics), cx - 15, cy - 3.5, { size: 7, bold: true, w: 30, align: 'center', color: '#222222' });
                    }
                }
                y += alto + 8;
                for (const e of lista) {
                    texto(`${nombreDeElemento(e.elemento)}${e.rect ? '' : ' (ventana emergente)'}`, M + 8, y, { size: 8.5, w: 300 });
                    texto(`${num(e.clics)} clics · ${e.usuarios} ${e.usuarios === 1 ? 'persona' : 'personas'} · ${num(e.participacion)}%`, M + 320, y, { size: 8.5, color: GRIS, w: UTIL - 328, align: 'right' });
                    y += 12;
                }
                y += 14;
            }
            if (i.pantallasOmitidas > 0) { texto(`Se muestran las pantallas con más clics; faltan ${i.pantallasOmitidas}. Elige pantallas concretas en «Personalizar».`, M, y, { size: 8.5, color: GRIS }); y += 16; }
        }

        // ── Personas ──
        if (i.personas) {
            titulo('Personas', 'De la más activa a la menos activa.');
            const col = [0, 175, 275, 320, 385, 430];
            const cab = ['Persona', 'Rol', 'Sesiones', 'Tiempo activo', 'Clics', 'Acciones'];
            const pintarCab = () => { doc.rect(M, y - 2, UTIL, 15).fill(AMARILLO); cab.forEach((c, k) => texto(c, M + col[k] + 4, y + 1, { size: 8, bold: true, w: (col[k + 1] ?? UTIL) - col[k] - 6 })); y += 17; };
            pintarCab();
            const lista = i.personas.slice(0, 40);
            lista.forEach((p, k) => {
                if (y + 16 > ALTO - M - PIE) { doc.addPage(); y = M; pintarCab(); }
                if (k % 2 === 0) doc.rect(M, y - 2, UTIL, 14).fill(SUAVE);
                const rol = `${p.rolPlataforma ?? '-'}${p.rolTienda ? ' / ' + p.rolTienda : ''}`;
                [p.nombre, rol, String(p.sesiones), duracion(p.segundosActivos), String(p.clics), String(p.acciones)].forEach((c, j) => texto(c, M + col[j] + 4, y + 1, { size: 8, w: (col[j + 1] ?? UTIL) - col[j] - 6 }));
                y += 14;
            });
            if (i.personas.length > lista.length) { y += 4; texto(`Se muestran ${lista.length} de ${i.personas.length} personas; el Excel trae la lista completa.`, M, y, { size: 8.5, color: GRIS }); y += 14; }
            y += 12;
        }

        // ── Línea de tiempo ──
        if (i.linea) {
            titulo(`Lo último que hizo ${i.persona ?? 'esta persona'}`, 'Pantallas abiertas, acciones e ingresos.');
            const verbo: Record<string, string> = { view: 'Abrió', action: 'Hizo', login: 'Ingresó' };
            if (!i.linea.length) texto('Sin movimientos en este periodo.', M, y, { size: 9, color: GRIS });
            for (const e of i.linea.slice(0, 40)) {
                asegurar(14);
                texto(cuando(e.at), M, y, { size: 8.5, color: GRIS, w: 100 });
                texto(`${verbo[e.tipo] ?? e.tipo} ${e.tipo === 'action' ? nombreDeElemento(e.accion ?? e.elemento ?? '') : e.tipo === 'login' ? 'la plataforma' : nombreDePantalla(e.pantalla)}`, M + 105, y, { size: 8.5, w: UTIL - 105 });
                y += 13;
            }
            y += 10;
        }

        // ── Cierre: qué trae este informe y cómo personalizarlo ──
        asegurar(70);
        doc.roundedRect(M, y, UTIL, 56, 6).fill('#FFF6D6');
        texto(i.opciones.completo ? 'Este informe incluye todos los datos.' : 'Informe personalizado.', M + 12, y + 9, { size: 9, bold: true, w: UTIL - 24 });
        texto(
            i.opciones.completo
                ? 'Puedes descargar información personalizada en Superadmin > Actividad > Descargar > Personalizar: eliges qué secciones, pantallas, personas y roles incluir.'
                : 'Contiene solo las secciones y pantallas elegidas. Para el informe completo usa Superadmin > Actividad > Descargar.',
            M + 12, y + 23, { size: 8.5, color: '#444444', w: UTIL - 24, });
        texto('Confidencial: solo para superadmins. Se registra únicamente a quienes aceptaron el aviso de privacidad; no se guarda lo que se escribe, contraseñas ni datos de clientes finales.', M + 12, y + 38, { size: 7.5, color: GRIS, w: UTIL - 24 });

        // ── Pie en todas las páginas ──
        const { start, count } = doc.bufferedPageRange();
        for (let k = 0; k < count; k++) {
            doc.switchToPage(start + k);
            doc.page.margins.bottom = 0;
            texto('Synkro AI · Confidencial: solo para superadmins', M, ALTO - 30, { size: 7.5, color: GRIS, w: 300 });
            texto(`Página ${k + 1} de ${count}`, M + 300, ALTO - 30, { size: 7.5, color: GRIS, w: UTIL - 300, align: 'right' });
        }
        doc.end();
    });
}
