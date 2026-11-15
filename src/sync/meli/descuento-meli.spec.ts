import { planDeDescuentoMeli, maxDiasPromoMeli, precioDeLaPromocionActiva, promosMeliActivas, rechazoDe } from './descuento-meli';

const base = { precio: 265, ultima: null as string | null, hoy: '2026-11-14', maxDias: 14 };
const promo = (salePrice: number, start: string | null, end: string | null) => ({ salePrice, start, end });

describe('planDeDescuentoMeli', () => {
    it('sin descuento y sin promoción previa no hace nada; con previa la quita', () => {
        expect(planDeDescuentoMeli({ ...base, promo: null })).toEqual({ tipo: 'nada' });
        expect(planDeDescuentoMeli({ ...base, promo: null, ultima: '200|2026-11-01|2026-11-14' })).toEqual({ tipo: 'quitar' });
    });

    it('un descuento largo pone solo el primer tramo de 14 días', () => {
        const p = planDeDescuentoMeli({ ...base, promo: promo(225, '2026-11-14', '2027-11-13') });
        expect(p).toEqual({ tipo: 'poner', quitarAntes: false, dealPrice: 225, desde: '2026-11-14', hasta: '2026-11-27', firma: '225|2026-11-14|2026-11-27' });
    });

    it('si ya está puesto el tramo de hoy, no repite', () => {
        const p = planDeDescuentoMeli({ ...base, promo: promo(225, '2026-11-14', '2027-11-13'), ultima: '225|2026-11-14|2026-11-27' });
        expect(p).toEqual({ tipo: 'nada' });
    });

    it('al cambiar de tramo reemplaza el anterior por el nuevo', () => {
        const p = planDeDescuentoMeli({ ...base, hoy: '2026-11-28', promo: promo(225, '2026-11-14', '2027-11-13'), ultima: '225|2026-11-14|2026-11-27' });
        expect(p).toMatchObject({ tipo: 'poner', quitarAntes: true, desde: '2026-11-28', hasta: '2026-12-11' });
    });

    it('un cambio de precio con descuento reemplaza la promoción', () => {
        const p = planDeDescuentoMeli({ ...base, promo: promo(200, '2026-11-14', '2026-11-20'), ultima: '225|2026-11-14|2026-11-20' });
        expect(p).toMatchObject({ tipo: 'poner', quitarAntes: true, dealPrice: 200, hasta: '2026-11-20' });
    });

    it('un descuento que empieza más adelante programa su primer tramo con esa fecha', () => {
        const p = planDeDescuentoMeli({ ...base, promo: promo(225, '2026-12-01', '2026-12-31') });
        expect(p).toMatchObject({ tipo: 'poner', desde: '2026-12-01', hasta: '2026-12-14' });
    });

    it('un descuento terminado se quita si había promoción', () => {
        expect(planDeDescuentoMeli({ ...base, hoy: '2027-02-01', promo: promo(225, '2026-11-14', '2027-01-31'), ultima: '225|x|y' })).toEqual({ tipo: 'quitar' });
        expect(planDeDescuentoMeli({ ...base, hoy: '2027-02-01', promo: promo(225, '2026-11-14', '2027-01-31') })).toEqual({ tipo: 'nada' });
    });

    it('fuera de 5%–80% se omite con el motivo (y se quita lo previo)', () => {
        const chico = planDeDescuentoMeli({ ...base, promo: promo(260, null, '2026-12-31'), ultima: 'a|b|c' });
        expect(chico).toMatchObject({ tipo: 'omitir', quitarAntes: true });
        expect((chico as any).motivo).toContain('entre 5% y 80%');
        expect(planDeDescuentoMeli({ ...base, promo: promo(40, null, '2026-12-31') })).toMatchObject({ tipo: 'omitir', quitarAntes: false });
    });

    it('sin fecha de fin no pone nada', () => {
        expect(planDeDescuentoMeli({ ...base, promo: promo(225, null, null) })).toMatchObject({ tipo: 'omitir' });
    });
});

describe('rechazo recordado de Mercado Libre', () => {
    const promoLarga = promo(225, '2026-11-14', '2027-11-13');
    const firma = '225|2026-11-14|2026-11-27';

    it('un descuento rechazado hace poco no se vuelve a pedir y se avisa', () => {
        const p = planDeDescuentoMeli({ ...base, promo: promoLarga, ultima: rechazoDe(firma, '2026-11-14') });
        expect(p).toEqual({ tipo: 'nada', rechazada: true });
        expect(planDeDescuentoMeli({ ...base, hoy: '2026-11-20', promo: promoLarga, ultima: rechazoDe(firma, '2026-11-14') })).toEqual({ tipo: 'nada', rechazada: true });
    });

    it('pasados 7 días se vuelve a intentar, sin intentar quitar nada (no había promoción puesta)', () => {
        const p = planDeDescuentoMeli({ ...base, hoy: '2026-11-21', promo: promoLarga, ultima: rechazoDe(firma, '2026-11-14') });
        expect(p).toMatchObject({ tipo: 'poner', quitarAntes: false, firma });
    });

    it('si el descuento cambió, se vuelve a intentar enseguida', () => {
        const p = planDeDescuentoMeli({ ...base, promo: promo(200, '2026-11-14', '2027-11-13'), ultima: rechazoDe(firma, '2026-11-14') });
        expect(p).toMatchObject({ tipo: 'poner', quitarAntes: false, dealPrice: 200 });
    });

    it('si el descuento se quitó, un rechazo anotado no genera un borrado', () => {
        expect(planDeDescuentoMeli({ ...base, promo: null, ultima: rechazoDe(firma, '2026-11-14') })).toEqual({ tipo: 'nada' });
    });
});

describe('precioDeLaPromocionActiva (para el precio tachado)', () => {
    it('devuelve el precio de la promoción en curso y null si no empezó, terminó o fue rechazada', () => {
        const u = '165|2026-11-14|2026-11-24';
        expect(precioDeLaPromocionActiva(u, '2026-11-14')).toBe(165);
        expect(precioDeLaPromocionActiva(u, '2026-11-24')).toBe(165);
        expect(precioDeLaPromocionActiva(u, '2026-11-13')).toBeNull();
        expect(precioDeLaPromocionActiva(u, '2026-11-25')).toBeNull();
        expect(precioDeLaPromocionActiva(rechazoDe(u, '2026-11-14'), '2026-11-15')).toBeNull();
        expect(precioDeLaPromocionActiva(null, '2026-11-15')).toBeNull();
        expect(precioDeLaPromocionActiva('basura', '2026-11-15')).toBeNull();
    });
});

describe('configuración', () => {
    const antes = { ...process.env };
    afterEach(() => { process.env = { ...antes }; });
    it('el plazo por defecto es 14 días y se puede cambiar', () => {
        delete process.env.MELI_PROMO_MAX_DIAS;
        expect(maxDiasPromoMeli()).toBe(14);
        process.env.MELI_PROMO_MAX_DIAS = '30';
        expect(maxDiasPromoMeli()).toBe(30);
        process.env.MELI_PROMO_MAX_DIAS = 'x';
        expect(maxDiasPromoMeli()).toBe(14);
    });
    it('los descuentos de Mercado Libre están apagados salvo MELI_PROMOS_ACTIVAS=true', () => {
        delete process.env.MELI_PROMOS_ACTIVAS;
        expect(promosMeliActivas()).toBe(false);
        process.env.MELI_PROMOS_ACTIVAS = 'true';
        expect(promosMeliActivas()).toBe(true);
    });
});
