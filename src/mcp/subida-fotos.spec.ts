import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
const request = require('supertest');
import { TransformInterceptor } from '../common/interceptors/transform.interceptor';
import { SubidaDeFotosController, EnlaceDeSubidaGuard } from './subida-fotos.controller';
import { direccionPublica, SubidaDeFotosService } from './subida-fotos.service';

function redisFalso() {
    const datos = new Map<string, string>();
    const conjuntos = new Map<string, Set<string>>();
    return {
        set: jest.fn(async (k: string, v: string, ...a: any[]) => { if (a.includes('NX') && datos.has(k)) return null; datos.set(k, v); return 'OK'; }),
        get: jest.fn(async (k: string) => datos.get(k) ?? null),
        del: jest.fn(async (k: string) => { datos.delete(k); return 1; }),
        sadd: jest.fn(async (k: string, ...v: string[]) => { const s = conjuntos.get(k) ?? new Set(); v.forEach((x) => s.add(x)); conjuntos.set(k, s); return v.length; }),
        sismember: jest.fn(async (k: string, v: string) => (conjuntos.get(k)?.has(v) ? 1 : 0)),
        expire: jest.fn(async () => 1),
    };
}

const acceso: any = { keyId: 'k1', userId: 'u1', storeId: 's1' };

describe('enlace para subir fotos', () => {
    let app: INestApplication;
    let servicio: SubidaDeFotosService;
    const clave: any = { revokedAt: null, expiresAt: null };
    let permisos = ['productos.ver', 'productos.editar'];
    const upload = { uploadImages: jest.fn(async (f: any[]) => f.map((_, i) => ({ secureUrl: `https://fotos.test/${i + 1}.jpg` }))) };

    beforeAll(async () => {
        process.env.PUBLIC_API_URL = 'https://api.test/';
        servicio = new SubidaDeFotosService(
            redisFalso() as any,
            { findOne: jest.fn(async () => clave) } as any,
            { findOne: jest.fn(async () => ({ id: 's1', name: 'Tienda de prueba' })) } as any,
            { requireAccess: jest.fn(async () => ({ permissions: permisos })) } as any,
            upload as any,
        );
        const modulo = await Test.createTestingModule({
            controllers: [SubidaDeFotosController],
            providers: [EnlaceDeSubidaGuard, { provide: SubidaDeFotosService, useValue: servicio }],
        }).compile();
        app = modulo.createNestApplication();
        app.setGlobalPrefix('api/v1');
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
        app.useGlobalInterceptors(new TransformInterceptor());
        await app.init();
    });
    afterAll(async () => { await app.close(); delete process.env.PUBLIC_API_URL; });
    beforeEach(() => { clave.revokedAt = null; permisos = ['productos.ver', 'productos.editar']; upload.uploadImages.mockClear(); });

    const ruta = '/api/v1/mcp/subir-fotos';
    const nuevo = async () => { const r = await servicio.crearEnlace(acceso); return { ...r, token: r.enlace.split('#')[1] }; };
    const enviar = (token: string) => request(app.getHttpServer()).post(ruta).set('Authorization', `Bearer ${token}`).attach('images', Buffer.from('jpg'), { filename: 'rojo.jpg', contentType: 'image/jpeg' });

    it('el secreto va detrás de # y la dirección es la pública del servidor', async () => {
        const e = await nuevo();
        expect(e.enlace).toMatch(/^https:\/\/api\.test\/api\/v1\/mcp\/subir-fotos#[A-Za-z0-9_-]{40,}$/);
        expect(direccionPublica({ RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' } as any)).toBe('https://x.up.railway.app');
        expect(direccionPublica({} as any)).toBe('');
    });

    it('la página se sirve sin datos, sin caché y con una política que no deja cargar nada de fuera', async () => {
        const r = await request(app.getHttpServer()).get(ruta).expect(200);
        expect(r.headers['content-type']).toMatch(/text\/html/);
        expect(r.headers['cache-control']).toBe('no-store');
        const nonce = /script-src 'nonce-([^']+)'/.exec(r.headers['content-security-policy'])![1];
        expect(r.text).toContain(`<script nonce="${nonce}">`);
    });

    it('sube, deja las fotos para el asistente y el enlace se gasta', async () => {
        const e = await nuevo();
        const estado = await request(app.getHttpServer()).get(`${ruta}/estado`).set('Authorization', `Bearer ${e.token}`).expect(200);
        expect(estado.body).toEqual({ tienda: 'Tienda de prueba', maximo: 30 });
        await expect(servicio.fotosDe('s1', e.subidaId)).resolves.toEqual([]);

        const r = await enviar(e.token).expect(200);
        expect(r.body).toEqual({ subidas: 1 });
        await expect(servicio.fotosDe('s1', e.subidaId)).resolves.toEqual([{ n: 1, nombre: 'rojo.jpg', url: 'https://fotos.test/1.jpg' }]);
        await enviar(e.token).expect(401);
    });

    it('las fotos son solo de su tienda', async () => {
        const e = await nuevo();
        await enviar(e.token).expect(200);
        await expect(servicio.fotosDe('otra', e.subidaId)).rejects.toThrow(/No hay ninguna subida/);
        expect((await servicio.yaSubidas('s1', ['https://fotos.test/1.jpg', 'https://x.test/a.jpg']))).toEqual(new Set(['https://fotos.test/1.jpg']));
        expect((await servicio.yaSubidas('otra', ['https://fotos.test/1.jpg'])).size).toBe(0);
    });

    it('sin enlace vigente no se recibe nada: sin secreto, inventado, clave revocada o permiso perdido', async () => {
        await request(app.getHttpServer()).post(ruta).expect(401);
        await enviar('inventado').expect(401);
        const e = await nuevo();
        clave.revokedAt = new Date();
        await enviar(e.token).expect(401);
        clave.revokedAt = null;
        permisos = ['productos.ver'];
        await enviar(e.token).expect(401);
        expect(upload.uploadImages).not.toHaveBeenCalled();
    });

    it('si la subida falla, el enlace sigue sirviendo', async () => {
        const e = await nuevo();
        upload.uploadImages.mockRejectedValueOnce(new Error('Cloudinary caído'));
        await enviar(e.token).expect(500);
        await enviar(e.token).expect(200);
    });
});
