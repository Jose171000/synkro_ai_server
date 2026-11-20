import { BadRequestException } from '@nestjs/common';
import { ChangeRequestsService } from './change-requests.service';

/**
 * La cola de revisión existe para que un precio mal tecleado no llegue solo
 * a Falabella. Lo que se protege aquí: nada se envía hasta aprobar, aprobar
 * dos veces no envía dos veces, solo se registran cambios que cambian algo,
 * y cada cambio va a UNA cuenta del canal (una tienda puede tener varias).
 */
const SCOPE = { userId: 'u1', storeId: 't1' };

function construir(over: { solicitud?: any; producto?: any; claimed?: number; enlace?: any; otrosEnlaces?: any[] } = {}) {
    const guardadas: any[] = [];
    const repo = {
        update: jest.fn().mockResolvedValue({ affected: over.claimed ?? 1 }),
        save: jest.fn(async (e: any) => { guardadas.push(e); return { id: `r${guardadas.length}`, ...e }; }),
        create: jest.fn((e: any) => e),
        findOne: jest.fn().mockResolvedValue(over.solicitud ?? null),
        find: jest.fn().mockResolvedValue([]),
    };
    const productos = {
        findOne: jest.fn().mockResolvedValue(over.producto ?? null),
        save: jest.fn(async (p: any) => p),
    };
    const tiendas = { findOne: jest.fn(), update: jest.fn() };
    const cola = { add: jest.fn() };
    const enlaces = { findOne: jest.fn().mockResolvedValue(over.enlace ?? null), find: jest.fn().mockResolvedValue(over.otrosEnlaces ?? []), save: jest.fn(async (e: any) => e) };
    const service = new ChangeRequestsService(repo as any, productos as any, tiendas as any, cola as any, enlaces as any);
    return { service, repo, productos, tiendas, cola, guardadas, enlaces };
}

const producto = { id: 'p1', price: 100, stock: 10 } as any;

describe('modo revisión de la tienda', () => {
    it('sin ajuste guardado se revisa: es el lado seguro', async () => {
        const { service, tiendas } = construir();
        tiendas.findOne.mockResolvedValue(null);
        await expect(service.isReviewMode('t1')).resolves.toBe(true);
        tiendas.findOne.mockResolvedValue({ syncReviewMode: false });
        await expect(service.isReviewMode('t1')).resolves.toBe(false);
    });

    it('el ajuste se guarda en la tienda, no en la persona', async () => {
        const { service, tiendas } = construir();
        await service.setReviewMode('t1', false);
        expect(tiendas.update).toHaveBeenCalledWith({ id: 't1' }, { syncReviewMode: false });
    });

    it('crea una solicitud por cuenta y por campo que cambia', async () => {
        const { service, guardadas } = construir();
        const creadas = await service.createFromInventory(SCOPE, producto, { price: 90, stock: 4 }, [
            { marketplace: 'falabella', connectionId: 'c-fal-1' },
            { marketplace: 'falabella', connectionId: 'c-fal-2' },
            { marketplace: 'mercadolibre', connectionId: 'c-ml' },
        ]);
        expect(creadas).toHaveLength(6);
        expect(guardadas.map(g => `${g.connection.id}:${g.field}`).sort()).toEqual([
            'c-fal-1:price', 'c-fal-1:stock', 'c-fal-2:price', 'c-fal-2:stock', 'c-ml:price', 'c-ml:stock',
        ]);
        expect(guardadas.find(g => g.field === 'price')).toMatchObject({
            previousValue: '100', newValue: '90', status: 'pending', store: { id: 't1' },
        });
    });

    it('ignora los campos que no cambian', async () => {
        const { service } = construir();
        const creadas = await service.createFromInventory(SCOPE, producto, { price: 100, stock: 4 }, [
            { marketplace: 'falabella', connectionId: 'c1' },
        ]);
        expect(creadas).toHaveLength(1);
        expect(creadas[0].field).toBe('stock');
    });

    it('reemplaza la solicitud pendiente anterior de lo mismo en ESA cuenta', async () => {
        const { service, repo } = construir();
        await service.createFromInventory(SCOPE, producto, { stock: 4 }, [{ marketplace: 'falabella', connectionId: 'c1' }]);
        expect(repo.update).toHaveBeenCalledWith(
            expect.objectContaining({ connection: { id: 'c1' }, field: 'stock', status: 'pending' }),
            expect.objectContaining({ status: 'rejected' }),
        );
    });

    it('rechaza un filtro de estado inválido', async () => {
        const { service } = construir();
        await expect(service.list(SCOPE, 'inventado')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sin filtro trae TODAS las pendientes (aunque pasen de 200) y solo las 200 últimas ya resueltas', async () => {
        const { service, repo } = construir();
        const f = (id: string, status: string, t: number) => ({ id, status, createdAt: new Date(t) });
        repo.find.mockResolvedValueOnce([f('p1', 'pending', 1), f('p2', 'pending', 3)]).mockResolvedValueOnce([f('h1', 'sent', 2)]);
        const r = await service.list(SCOPE);
        expect(repo.find.mock.calls[0][0].take).toBe(2000);
        expect(repo.find.mock.calls[0][0].where[0]).toMatchObject({ status: 'pending' });
        expect(repo.find.mock.calls[1][0].take).toBe(200);
        expect(r.map((x: any) => x.id)).toEqual(['p2', 'h1', 'p1']); // juntas y de la más reciente a la más antigua
    });

    describe('historial paginado', () => {
        function armarQb(resultado: [any[], number]) {
            const qb: any = {};
            for (const m of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy', 'skip', 'take']) qb[m] = jest.fn(() => qb);
            qb.getManyAndCount = jest.fn(async () => resultado);
            return qb;
        }

        it('devuelve la página pedida con el total, y filtra por estado, campo y búsqueda', async () => {
            const { service, repo } = construir();
            const qb = armarQb([[{ id: 'a' }, { id: 'b' }], 667]);
            (repo as any).createQueryBuilder = jest.fn(() => qb);
            const r = await service.history(SCOPE, { page: 3, limit: 100, status: 'error', field: 'promo', q: ' MOC-INE ' });
            expect(r).toMatchObject({ total: 667, page: 3, limit: 100, totalPages: 7 });
            expect(qb.skip).toHaveBeenCalledWith(200);
            expect(qb.take).toHaveBeenCalledWith(100);
            const condiciones = qb.andWhere.mock.calls.map((c: any[]) => c[0]);
            expect(condiciones).toEqual(expect.arrayContaining(['r.status = :status', 'r.field = :field', '(p.sku ILIKE :q OR p.name ILIKE :q)']));
            expect(qb.andWhere.mock.calls.find((c: any[]) => c[0].includes('ILIKE'))[1]).toEqual({ q: '%MOC-INE%' });
        });

        it('sin filtro de estado excluye las pendientes; no admite «pending» ni valores inventados; limita el tamaño de página', async () => {
            const { service, repo } = construir();
            const qb = armarQb([[], 0]);
            (repo as any).createQueryBuilder = jest.fn(() => qb);
            await service.history(SCOPE, { limit: 9999 });
            expect(qb.andWhere.mock.calls[0][0]).toBe("r.status <> 'pending'");
            expect(qb.take).toHaveBeenCalledWith(200);
            await expect(service.history(SCOPE, { status: 'pending' })).rejects.toBeInstanceOf(BadRequestException);
            await expect(service.history(SCOPE, { field: 'otro' })).rejects.toBeInstanceOf(BadRequestException);
        });

        it('escapa los comodines de LIKE que escriba el usuario', async () => {
            const { service, repo } = construir();
            const qb = armarQb([[], 0]);
            (repo as any).createQueryBuilder = jest.fn(() => qb);
            await service.history(SCOPE, { q: '50%_off' });
            expect(qb.andWhere.mock.calls.find((c: any[]) => c[0].includes('ILIKE'))[1]).toEqual({ q: '%50\\%\\_off%' });
        });
    });

    it('lista las de la tienda, y las antiguas sin tienda solo a quien las pidió', async () => {
        const { service, repo } = construir();
        await service.list(SCOPE, 'pending');
        const donde = repo.find.mock.calls[0][0].where;
        expect(donde).toHaveLength(2);
        expect(donde[0]).toMatchObject({ store: { id: 't1' }, status: 'pending' });
        expect(donde[1]).toMatchObject({ requestedBy: { id: 'u1' } });
    });
});

describe('aprobar y rechazar', () => {
    const solicitud = {
        id: 'r1', field: 'price', newValue: '90', marketplace: 'falabella', status: 'pending',
        product: { id: 'p1' }, connection: { id: 'c1' },
    };

    it('aprobar aplica el valor al producto y encola el envío a esa cuenta', async () => {
        const { service, productos, cola } = construir({ solicitud: { ...solicitud, marketplace: 'ripley' }, producto: { ...producto } });
        await service.approve('r1', SCOPE);
        expect(productos.save).toHaveBeenCalledWith(expect.objectContaining({ price: 90 }));
        expect(cola.add).toHaveBeenCalledWith('inventory', {
            productId: 'p1', userId: 'u1', marketplace: 'ripley', connectionId: 'c1', changeRequestId: 'r1',
            // Ripley manda un solo campo por vez: la solicitud dice cuál.
            conPrecio: true, conStock: false,
        });
    });

    it('en Falabella aprobar NO encola un envío por solicitud: pide un lote (varias aprobaciones, un solo feed)', async () => {
        const { service, productos, cola } = construir({ solicitud, producto: { ...producto } });
        await service.approve('r1', SCOPE);
        expect(productos.save).toHaveBeenCalledWith(expect.objectContaining({ price: 90 }));
        expect(cola.add).not.toHaveBeenCalledWith('inventory', expect.anything());
        expect(cola.add).toHaveBeenCalledWith('falabella-lote', { connectionId: 'c1' }, expect.objectContaining({ jobId: 'falabella-lote-c1-espera' }));
    });

    it('el lote toma las solicitudes aprobadas, hasta 100 productos distintos (las dos de un producto van juntas)', async () => {
        const reqs = [
            ...Array.from({ length: 101 }, (_, i) => ({ id: `a${i}`, product: { id: `p${i}` } })),
            { id: 'b0', product: { id: 'p0' } },
        ];
        const { service, repo } = construir();
        repo.find.mockResolvedValueOnce(reqs);
        const elegidas = await service.aprobadasDeFalabella('c1');
        expect(new Set(elegidas.map((r: any) => r.product.id)).size).toBe(100);
        expect(elegidas.map((r: any) => r.id)).toContain('b0'); // la segunda solicitud de p0 entra con la primera
        expect(elegidas.map((r: any) => r.id)).not.toContain('a100');
    });

    it('reintentar solo vuelve a aprobar las rechazadas por límite (429) y programa su lote', async () => {
        const { service, repo, cola } = construir();
        repo.find.mockResolvedValueOnce([
            { id: 'e1', resultMessage: 'Falabella rechazó la petición ProductUpdate: 429 Too many attempts to Create feeds.', connection: { id: 'c1' } },
            { id: 'e2', resultMessage: 'El SKU no existe', connection: { id: 'c1' } },
        ]);
        const r = await service.reintentarLimitadasDeFalabella(SCOPE);
        expect(r).toEqual({ reintentadas: 1 });
        expect(repo.update).toHaveBeenCalledWith({ id: expect.anything() }, expect.objectContaining({ status: 'approved', resultMessage: null }));
        expect(cola.add).toHaveBeenCalledWith('falabella-lote', { connectionId: 'c1' }, expect.anything());
    });

    it('un reenvío de precio es una solicitud de precio que reemplaza a otra pendiente de lo mismo', async () => {
        const { service, repo } = construir();
        await service.createPriceResend(SCOPE, { id: 'p1', price: 60 } as any, { marketplace: 'ripley', connectionId: 'c1', channelPrice: 35 });
        expect(repo.update).toHaveBeenCalledWith(
            { product: { id: 'p1' }, connection: { id: 'c1' }, field: 'price', status: 'pending' },
            expect.objectContaining({ status: 'rejected' }),
        );
        expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ field: 'price', previousValue: '35', newValue: '60', marketplace: 'ripley', status: 'pending' }));
    });

    it('un descuento por canal no toca el producto: aprobarlo solo lo manda a esa cuenta, con su valor', async () => {
        const promo = { id: 'r9', field: 'promo', newValue: '120|2026-11-09|2027-09-30', marketplace: 'ripley', status: 'pending', product: { id: 'p1' }, connection: { id: 'c1' } };
        const { service, productos, cola } = construir({ solicitud: promo, producto: { ...producto } });
        await service.approve('r9', SCOPE);
        expect(productos.save).not.toHaveBeenCalled();
        expect(cola.add).toHaveBeenCalledWith('inventory', expect.objectContaining({
            marketplace: 'ripley', connectionId: 'c1', changeRequestId: 'r9', conPrecio: false, conStock: false,
            conDescuento: true, descuento: { precio: 120, desde: '2026-11-09', hasta: '2027-09-30' },
        }));
    });

    it('quitar un descuento viaja como «quitar»; un valor dañado no se envía y la solicitud queda con error', async () => {
        const quitar = { id: 'r8', field: 'promo', newValue: 'quitar', marketplace: 'ripley', status: 'pending', product: { id: 'p1' }, connection: { id: 'c1' } };
        const a = construir({ solicitud: quitar, producto: { ...producto } });
        await a.service.approve('r8', SCOPE);
        expect(a.cola.add).toHaveBeenCalledWith('inventory', expect.objectContaining({ conDescuento: true, descuento: { precio: null } }));

        const mala = { ...quitar, id: 'r7', newValue: 'abc' };
        const b = construir({ solicitud: mala, producto: { ...producto } });
        await expect(b.service.approve('r7', SCOPE)).rejects.toThrow(/no es válido/);
        expect(b.cola.add).not.toHaveBeenCalled();
        expect(b.repo.update).toHaveBeenLastCalledWith({ id: 'r7' }, expect.objectContaining({ status: 'error' }));
    });

    describe('descuentos de Falabella', () => {
        const promoFa = (extra: any) => ({ id: 'f1', field: 'promo', marketplace: 'falabella', status: 'pending', product: { id: 'p1' }, connection: { id: 'c1' }, newValue: '70|2026-08-02|2026-12-01', ...extra });

        it('el descuento de una cuenta se guarda en SU publicación (no en el producto) y se manda a esa cuenta', async () => {
            const enlace: any = { id: 'l1' };
            const { service, productos, enlaces, cola } = construir({ solicitud: promoFa({}), producto: { ...producto }, enlace });
            await service.approve('f1', SCOPE);
            expect(productos.save).not.toHaveBeenCalled();
            expect(enlaces.save).toHaveBeenCalledWith(expect.objectContaining({ salePriceOverride: 70, saleStartOverride: '2026-08-02', saleEndOverride: '2026-12-01' }));
            expect(cola.add).toHaveBeenCalledWith('falabella-lote', { connectionId: 'c1' }, expect.anything());
        });

        it('el descuento general (marca «|g») se guarda en el producto', async () => {
            const { service, productos, enlaces, cola } = construir({ solicitud: promoFa({ newValue: '70|2026-08-02|2026-12-01|g' }), producto: { ...producto } });
            await service.approve('f1', SCOPE);
            expect(productos.save).toHaveBeenCalledWith(expect.objectContaining({ salePrice: 70, saleStartDate: '2026-08-02', saleEndDate: '2026-12-01' }));
            expect(enlaces.save).not.toHaveBeenCalled();
            expect(cola.add).toHaveBeenCalledTimes(1);
        });

        it('aprobar el descuento de una cuenta de Mercado Libre lo deja solo en SU publicación y lo manda solo a esa cuenta', async () => {
            const enlace: any = { id: 'lm' };
            const { service, productos, enlaces, cola } = construir({ solicitud: promoFa({ marketplace: 'mercadolibre', connection: { id: 'cm1' } }), producto: { ...producto }, enlace });
            await service.approve('f1', SCOPE);
            expect(productos.save).not.toHaveBeenCalled(); // el producto no cambia: los demás canales no reciben nada
            expect(enlaces.save).toHaveBeenCalledWith(expect.objectContaining({ salePriceOverride: 70, saleStartOverride: '2026-08-02', saleEndOverride: '2026-12-01' }));
            expect(cola.add).toHaveBeenCalledTimes(1);
            expect(cola.add).toHaveBeenCalledWith('inventory', expect.objectContaining({ marketplace: 'mercadolibre', connectionId: 'cm1', changeRequestId: 'f1' }));
        });

        it('lo mismo con WooCommerce, y aprobar un canal nunca manda el descuento a los demás', async () => {
            const { service, cola, enlaces } = construir({ solicitud: promoFa({ marketplace: 'woocommerce', connection: { id: 'cw1' } }), producto: { ...producto }, enlace: { id: 'lw' }, otrosEnlaces: [{ marketplace: 'mercadolibre', connection: { id: 'cm1' } }] });
            await service.approve('f1', SCOPE);
            expect(enlaces.find).not.toHaveBeenCalled();
            expect(cola.add).toHaveBeenCalledTimes(1);
            expect(cola.add).toHaveBeenCalledWith('inventory', expect.objectContaining({ marketplace: 'woocommerce', connectionId: 'cw1' }));
        });

        it('retirar el descuento GENERAL en Mercado Libre limpia el del producto y el de la cuenta, y se manda', async () => {
            const enlace: any = { id: 'lm', salePriceOverride: 165, saleStartOverride: '2026-11-14', saleEndOverride: '2026-11-24' };
            const { service, productos, enlaces, cola } = construir({ solicitud: promoFa({ marketplace: 'mercadolibre', connection: { id: 'cm1' }, newValue: 'quitar|g' }), producto: { ...producto, salePrice: 165 }, enlace });
            await service.approve('f1', SCOPE);
            expect(productos.save).toHaveBeenCalledWith(expect.objectContaining({ salePrice: null, saleStartDate: null, saleEndDate: null }));
            expect(enlaces.save).toHaveBeenCalledWith(expect.objectContaining({ salePriceOverride: null, saleStartOverride: null, saleEndOverride: null }));
            expect(cola.add).toHaveBeenCalledWith('inventory', expect.objectContaining({ marketplace: 'mercadolibre', connectionId: 'cm1' }));
        });

        it('retirar el descuento general en Falabella limpia el del producto y no toca la oferta propia de la cuenta (la conserva el Seller Center)', async () => {
            const { service, productos, enlaces, cola } = construir({ solicitud: promoFa({ newValue: 'quitar|g' }), producto: { ...producto, salePrice: 165 }, enlace: { id: 'lf', salePriceOverride: 165 } });
            await service.approve('f1', SCOPE);
            expect(productos.save).toHaveBeenCalledWith(expect.objectContaining({ salePrice: null }));
            expect(enlaces.save).not.toHaveBeenCalled();
            expect(cola.add).not.toHaveBeenCalled();
        });

        it('quitar el descuento en Mercado Libre sí se manda (el canal lo quita solo); en Falabella no', async () => {
            const enlace: any = { id: 'lm', salePriceOverride: 70 };
            const { service, enlaces, cola, repo } = construir({ solicitud: promoFa({ marketplace: 'mercadolibre', connection: { id: 'cm1' }, newValue: 'quitar' }), producto: { ...producto }, enlace });
            await service.approve('f1', SCOPE);
            expect(enlaces.save).toHaveBeenCalledWith(expect.objectContaining({ salePriceOverride: null, saleStartOverride: null, saleEndOverride: null }));
            expect(cola.add).toHaveBeenCalledWith('inventory', expect.objectContaining({ marketplace: 'mercadolibre', connectionId: 'cm1' }));
            expect(repo.update).not.toHaveBeenLastCalledWith({ id: 'f1' }, expect.objectContaining({ status: 'skipped' }));
        });

        it('quitar un descuento lo borra de Synkro y no manda nada: la solicitud queda como «No enviado» con el aviso del Seller Center', async () => {
            const enlace: any = { id: 'l1', salePriceOverride: 70 };
            const { service, enlaces, cola, repo } = construir({ solicitud: promoFa({ newValue: 'quitar' }), producto: { ...producto }, enlace });
            const r = await service.approve('f1', SCOPE);
            expect(enlaces.save).toHaveBeenCalledWith(expect.objectContaining({ salePriceOverride: null, saleStartOverride: null, saleEndOverride: null }));
            expect(cola.add).not.toHaveBeenCalled();
            expect(r.message).toMatch(/Seller Center/);
            expect(repo.update).toHaveBeenLastCalledWith({ id: 'f1' }, expect.objectContaining({ status: 'skipped' }));
        });

        it('si la cuenta ya no tiene esa publicación, la solicitud queda con error y no se envía', async () => {
            const { service, cola, repo } = construir({ solicitud: promoFa({}), producto: { ...producto }, enlace: null });
            await expect(service.approve('f1', SCOPE)).rejects.toThrow(/publicación/);
            expect(cola.add).not.toHaveBeenCalled();
            expect(repo.update).toHaveBeenLastCalledWith({ id: 'f1' }, expect.objectContaining({ status: 'error' }));
        });
    });

    it('crear una solicitud de descuento reemplaza a otra pendiente de lo mismo', async () => {
        const { service, repo } = construir();
        await service.createPromoRequest(SCOPE, { id: 'p1' } as any, { marketplace: 'ripley', connectionId: 'c1', previous: '120', next: '100||' });
        expect(repo.update).toHaveBeenCalledWith(
            { product: { id: 'p1' }, connection: { id: 'c1' }, field: 'promo', status: 'pending' },
            expect.objectContaining({ status: 'rejected' }),
        );
        expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ field: 'promo', previousValue: '120', newValue: '100||', status: 'pending' }));
    });

    it('aprobar varias a la vez: cada una sigue sus reglas y una ya resuelta o que falla no frena a las demás', async () => {
        const { service, repo, cola } = construir({ solicitud, producto: { ...producto } });
        repo.update
            .mockResolvedValueOnce({ affected: 1 }) // r1: se aprueba
            .mockResolvedValueOnce({ affected: 0 }); // r2: ya estaba resuelta
        const r = await service.approveMany(['r1', 'r2', 'r1'], SCOPE); // el repetido cuenta una vez
        expect(r.aprobadas).toBe(1);
        expect(r.omitidas).toEqual([{ id: 'r2', motivo: expect.stringContaining('ya fue resuelta') }]);
        expect(cola.add).toHaveBeenCalledTimes(1);
    });

    it('rechazar varias a la vez con el mismo motivo', async () => {
        const { service, repo } = construir({ solicitud, producto: { ...producto } });
        repo.update.mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 });
        const r = await service.rejectMany(['a', 'b', 'c'], SCOPE, 'precio mal escrito');
        expect(r.rechazadas).toBe(2);
        expect(r.omitidas).toEqual([{ id: 'c', motivo: expect.stringContaining('ya fue resuelta') }]);
        expect(repo.update).toHaveBeenCalledWith({ id: 'a', status: 'pending' }, expect.objectContaining({ status: 'rejected', resultMessage: 'precio mal escrito' }));
    });

    it('una solicitud de otra tienda no se puede aprobar', async () => {
        const { service, cola } = construir({ solicitud: null });
        await expect(service.approve('r-ajena', SCOPE)).rejects.toThrow(/no encontrada/i);
        expect(cola.add).not.toHaveBeenCalled();
    });

    it('aprobar una solicitud ya resuelta no encola nada', async () => {
        const { service, cola } = construir({ solicitud, producto: { ...producto }, claimed: 0 });
        await expect(service.approve('r1', SCOPE)).rejects.toBeInstanceOf(BadRequestException);
        expect(cola.add).not.toHaveBeenCalled();
    });

    it('rechazar no toca el producto ni la cola', async () => {
        const { service, productos, cola, repo } = construir({ solicitud });
        await service.reject('r1', SCOPE, 'precio mal tecleado');
        expect(repo.update).toHaveBeenCalledWith(
            { id: 'r1', status: 'pending' },
            expect.objectContaining({ status: 'rejected', resultMessage: 'precio mal tecleado' }),
        );
        expect(productos.save).not.toHaveBeenCalled();
        expect(cola.add).not.toHaveBeenCalled();
    });

    it('una solicitud que el canal omitió a propósito queda «skipped» con su motivo, no «sent»', async () => {
        const { service, repo } = construir();
        await service.markSkipped('r1', 'El envío a Ripley está apagado');
        expect(repo.update).toHaveBeenLastCalledWith({ id: 'r1' }, expect.objectContaining({ status: 'skipped', resultMessage: 'El envío a Ripley está apagado' }));
    });

    it('el worker cierra la solicitud como enviada o con error', async () => {
        const { service, repo } = construir();
        await service.markResult('r1', true);
        expect(repo.update).toHaveBeenLastCalledWith({ id: 'r1' }, expect.objectContaining({ status: 'sent' }));
        await service.markResult('r1', false, 'Falabella rechazó el lote');
        expect(repo.update).toHaveBeenLastCalledWith({ id: 'r1' }, expect.objectContaining({ status: 'error', resultMessage: 'Falabella rechazó el lote' }));
    });
});
