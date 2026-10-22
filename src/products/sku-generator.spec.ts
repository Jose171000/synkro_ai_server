process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test';
import { analizarSku, armarSku, iniciales, mayorNumeroConPrefijo, patronDominante } from './sku-generator';
import { SkuGeneratorService } from './sku-generator.service';

describe('reconocer el formato de SKU de una tienda', () => {
    it('parte un SKU en prefijo, número y relleno de ceros', () => {
        expect(analizarSku('C0155')).toEqual({ prefijo: 'C', numero: 155, ancho: 4 });
        expect(analizarSku('CO126')).toEqual({ prefijo: 'CO', numero: 126, ancho: 3 });
        expect(analizarSku('BL000032')).toEqual({ prefijo: 'BL', numero: 32, ancho: 6 });
        expect(analizarSku('MK-TOR-004')).toEqual({ prefijo: 'MK-TOR-', numero: 4, ancho: 3 });
        expect(analizarSku('12345')).toEqual({ prefijo: '', numero: 12345, ancho: 5 });
    });

    it('descarta los que no sirven para deducir el formato (variantes, sin número final)', () => {
        expect(analizarSku('KI-0013-ROJO-M')).toBeNull();
        expect(analizarSku('KI-0013-38')).toBeNull();
        expect(analizarSku('SETCUNA')).toBeNull();
    });

    it('el formato dominante es el que más se repite en el último bloque; en empate gana el más reciente', () => {
        expect(patronDominante(['C0250', 'C0249', 'CO126', 'C0155', 'VAJ-ARI-S4'])).toEqual({ prefijo: 'C', ancho: 4 });
        expect(patronDominante(['CO126', 'C0250'])).toEqual({ prefijo: 'CO', ancho: 3 });
        expect(patronDominante(['SETCUNA', 'ABC'])).toBeNull();
    });

    it('arma el siguiente con el mismo relleno y encuentra el mayor número usado', () => {
        expect(armarSku('C', 156, 4)).toBe('C0156');
        expect(armarSku('BL', 33, 6)).toBe('BL000033');
        expect(armarSku('C', 12345, 4)).toBe('C12345');
        expect(mayorNumeroConPrefijo(['C0155', 'c0250', 'CO126', 'C12'], 'C')).toBe(250);
        expect(mayorNumeroConPrefijo([], 'C')).toBe(0);
    });

    it('las iniciales de la tienda forman el prefijo por defecto', () => {
        expect(iniciales('Kassari Import')).toBe('KI');
        expect(iniciales('Maba Kids')).toBe('MK');
        expect(iniciales('Corporación Médica')).toBe('CM');
        expect(iniciales('Lai')).toBe('LAI');
        expect(iniciales('')).toBe('SKU');
    });
});

/** Repositorio en memoria: productos de la tienda con su SKU, y cuáles están publicados (el más reciente primero). */
function construir(opciones: { publicados: string[]; todos: string[]; tienda?: string }) {
    const repo: any = {
        createQueryBuilder: () => {
            let modo: 'publicados' | 'creados' | 'prefijo' = 'creados';
            let comodin = '';
            const qb: any = {
                select: () => qb,
                addSelect: () => { modo = 'publicados'; return qb; },
                innerJoin: () => qb,
                where: () => qb,
                andWhere: (cond: string, params: any) => { if (cond.includes('LIKE')) { modo = 'prefijo'; comodin = params.comodin; } return qb; },
                groupBy: () => qb,
                orderBy: () => qb,
                limit: () => qb,
                getRawMany: async () => {
                    if (modo === 'publicados') return opciones.publicados.map((sku) => ({ sku }));
                    if (modo === 'prefijo') return opciones.todos.filter((s) => s.toLowerCase().startsWith(comodin.replace('%', '').replace(/\\/g, ''))).map((sku) => ({ sku }));
                    return opciones.todos.map((sku) => ({ sku }));
                },
            };
            return qb;
        },
    };
    const tiendas: any = { listMine: jest.fn(async () => ({ stores: [{ id: 't1', name: opciones.tienda ?? 'Kassari Import' }] })) };
    return new SkuGeneratorService(repo, tiendas);
}

describe('generar el siguiente SKU de la tienda', () => {
    const ambito = { userId: 'u1', storeId: 't1' };

    it('continúa el formato de los últimos publicados, con el siguiente número al mayor usado', async () => {
        const s = construir({ publicados: ['C0250', 'C0242', 'C0155'], todos: ['C0250', 'C0242', 'C0155', 'CO126', 'BL000032'] });
        expect(await s.siguientes(ambito)).toEqual(['C0251']);
        expect(await s.siguientes(ambito, 3)).toEqual(['C0251', 'C0252', 'C0253']);
    });

    it('respeta el prefijo y el relleno aunque la tienda mezcle formatos: gana el del último bloque', async () => {
        const s = construir({ publicados: ['BL000032', 'BL000031', 'C0155'], todos: ['BL000032', 'BL000031', 'C0155'] });
        expect(await s.siguientes(ambito)).toEqual(['BL000033']);
    });

    it('sin productos publicados usa los últimos creados, y sin ninguno el formato propio con las iniciales', async () => {
        expect(await construir({ publicados: [], todos: ['C0100', 'C0099'] }).siguientes(ambito)).toEqual(['C0101']);
        expect(await construir({ publicados: [], todos: [] }).siguientes(ambito)).toEqual(['KI-0001']);
        expect(await construir({ publicados: [], todos: [], tienda: 'Maba Kids' }).siguientes(ambito, 2)).toEqual(['MK-0001', 'MK-0002']);
    });

    it('no repite un SKU ocupado en el mismo lote', async () => {
        const s = construir({ publicados: ['C0010'], todos: ['C0010'] });
        expect(await s.siguientes(ambito, 3, new Set(['c0012']))).toEqual(['C0011', 'C0013', 'C0014']);
    });
});
