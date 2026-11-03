import { BadRequestException } from '@nestjs/common';
import { ActivityService } from './activity.service';
import { validarPlano } from './activity-validation';

const bloques = [
    { k: 'titulo', x: 20, y: 10, w: 200, h: 20 },
    { k: 'tabla', x: 20, y: 150, w: 960, h: 600 },
    { k: 'tarjeta', x: 20, y: 780, w: 460, h: 180 },
];
const plano = (extra: any = {}) => ({ screen: 'marketplaces.ventas', width: 1400, height: 1800, blocks: bloques, ...extra });

describe('plano de una pantalla: validación', () => {
    it('acepta un plano con sus bloques en milésimas', () => {
        expect(validarPlano(plano())).toEqual({ screen: 'marketplaces.ventas', ancho: 1400, alto: 1800, bloques });
    });

    it('NUNCA guarda texto: de cada bloque solo se toman tipo, posición y tamaño', () => {
        const conTexto = bloques.map((b) => ({ ...b, text: 'Luis Enrique Chavez', label: 'a@b.com', html: '<b>x</b>' }));
        const v = validarPlano(plano({ blocks: conTexto }))!;
        for (const b of v.bloques) expect(Object.keys(b).sort()).toEqual(['h', 'k', 'w', 'x', 'y']);
        expect(JSON.stringify(v)).not.toMatch(/Luis|a@b\.com|<b>/);
    });

    it('descarta tipos desconocidos, posiciones fuera de rango y bloques diminutos', () => {
        const v = validarPlano(plano({ blocks: [...bloques, { k: 'script', x: 1, y: 1, w: 50, h: 50 }, { k: 'boton', x: -5, y: 1, w: 50, h: 50 }, { k: 'boton', x: 1, y: 1, w: 50, h: 5000 }, { k: 'boton', x: 1, y: 1, w: 1, h: 1 }] }))!;
        expect(v.bloques).toHaveLength(3);
    });

    it('un bloque que se sale por la derecha o abajo se recorta al borde', () => {
        const v = validarPlano(plano({ blocks: [...bloques, { k: 'boton', x: 950, y: 980, w: 200, h: 100 }] }))!;
        expect(v.bloques[3]).toEqual({ k: 'boton', x: 950, y: 980, w: 50, h: 20 });
    });

    it('rechaza lo que no es un plano utilizable: pocos bloques, pantalla angosta o sin etiqueta', () => {
        expect(validarPlano(plano({ blocks: bloques.slice(0, 2) }))).toBeNull();
        expect(validarPlano(plano({ width: 390 }))).toBeNull();
        expect(validarPlano(plano({ width: 720 }))).not.toBeNull();
        expect(validarPlano(plano({ height: 50 }))).toBeNull();
        expect(validarPlano(plano({ screen: 'a@b.com' }))).toBeNull();
        expect(validarPlano(plano({ blocks: 'no' }))).toBeNull();
        expect(validarPlano(null)).toBeNull();
    });

    it('con más de 150 bloques se queda con los primeros 150', () => {
        const muchos = Array.from({ length: 400 }, (_, k) => ({ k: 'boton', x: k % 900, y: 10, w: 20, h: 10 }));
        expect(validarPlano(plano({ blocks: muchos }))!.bloques).toHaveLength(150);
    });
});

describe('plano de una pantalla: guardado', () => {
    function construir(opts: { consentimiento?: boolean; filas?: any[] } = {}) {
        const consultas: { sql: string; params: any[] }[] = [];
        const ds: any = { query: jest.fn(async (sql: string, params: any[]) => { consultas.push({ sql, params }); return opts.filas ?? [{ screen: 'x' }]; }) };
        const privacy: any = { tieneConsentimiento: jest.fn(async () => opts.consentimiento ?? true) };
        const servicio = new ActivityService({} as any, {} as any, ds, privacy, {} as any);
        return { servicio, consultas, ds };
    }

    it('sin aceptar el aviso no se guarda nada', async () => {
        const { servicio, ds } = construir({ consentimiento: false });
        expect(await servicio.guardarPlano({ id: 'u1' }, plano())).toEqual({ guardado: false, requiereAviso: true });
        expect(ds.query).not.toHaveBeenCalled();
    });

    it('guarda el plano y solo renueva uno que tiene más de 24 horas', async () => {
        const { servicio, consultas } = construir();
        expect(await servicio.guardarPlano({ id: 'u1' }, plano())).toEqual({ guardado: true, requiereAviso: false });
        expect(consultas[0].sql).toContain('INSERT INTO activity_layouts');
        expect(consultas[0].sql).toContain(`WHERE activity_layouts."capturedAt" < now() - ($5 || ' hours')::interval`);
        expect(consultas[0].params[0]).toBe('marketplaces.ventas');
        expect(JSON.parse(consultas[0].params[1])).toEqual(bloques);
        expect(consultas[0].params.slice(2)).toEqual([1400, 1800, '24']);
        // La persona que lo mandó no queda anotada en el plano: no es de nadie.
        expect(JSON.stringify(consultas[0].params)).not.toContain('u1');
    });

    it('si ya había uno reciente, no lo pisa y lo dice', async () => {
        const { servicio } = construir({ filas: [] });
        expect(await servicio.guardarPlano({ id: 'u1' }, plano())).toEqual({ guardado: false, requiereAviso: false });
    });

    it('un plano inválido es un error de la petición', async () => {
        const { servicio } = construir();
        await expect(servicio.guardarPlano({ id: 'u1' }, plano({ blocks: [] }))).rejects.toBeInstanceOf(BadRequestException);
    });
});
