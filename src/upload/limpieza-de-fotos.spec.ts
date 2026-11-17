import { LimpiezaDeFotos, fotosBorrables, publicIdDeCloudinary } from './limpieza-de-fotos';

const NUBE = 'dce6wpls5';
const nuestra = (id: string) => `https://res.cloudinary.com/${NUBE}/image/upload/v1794939832/products/${id}.jpg`;

describe('publicIdDeCloudinary: solo fotos nuestras', () => {
    it('saca el identificador de una foto de nuestra carpeta de productos', () => {
        expect(publicIdDeCloudinary(nuestra('abc123'), NUBE)).toBe('products/abc123');
        expect(publicIdDeCloudinary(`https://res.cloudinary.com/${NUBE}/image/upload/products/sin-version.jpg`, NUBE)).toBe('products/sin-version');
    });

    it('una foto de otra cuenta, de otra carpeta o de otro sitio nunca se toca', () => {
        expect(publicIdDeCloudinary(`https://res.cloudinary.com/otra/image/upload/v1/products/a.jpg`, NUBE)).toBeNull();
        expect(publicIdDeCloudinary(`https://res.cloudinary.com/${NUBE}/image/upload/v1/logos/a.jpg`, NUBE)).toBeNull();
        expect(publicIdDeCloudinary('https://falabella.scene7.com/is/image/a.jpg', NUBE)).toBeNull();
        expect(publicIdDeCloudinary('http://res.cloudinary.com/x', NUBE)).toBeNull();
        expect(publicIdDeCloudinary('', NUBE)).toBeNull();
        expect(publicIdDeCloudinary(nuestra('a'), undefined)).toBeNull();
    });
});

describe('fotosBorrables', () => {
    it('pide solo fotos de productos sin publicaciones activas y arma el filtro con parámetros', async () => {
        const query = jest.fn(async () => [{ url: nuestra('a') }, { url: nuestra('b') }]);
        const urls = await fotosBorrables({ query } as any, [{ columna: 'storeId', valor: 's1' }, { columna: 'ownerId', valor: 'u1' }]);
        expect(urls).toEqual([nuestra('a'), nuestra('b')]);
        const [sql, params] = query.mock.calls[0] as unknown as [string, string[]];
        expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM listing_links/);
        expect(sql).toMatch(/<> 'removed'/);
        expect(sql).toMatch(/p\."storeId" = \$1 OR p\."ownerId" = \$2/);
        expect(params).toEqual(['s1', 'u1']);
    });

    it('sin filtros no consulta nada', async () => {
        const query = jest.fn();
        expect(await fotosBorrables({ query } as any, [])).toEqual([]);
        expect(query).not.toHaveBeenCalled();
    });
});

describe('LimpiezaDeFotos.borrar', () => {
    const armar = (usos: Record<string, number>) => {
        const deleteImage = jest.fn(async () => undefined);
        const dataSource: any = { query: jest.fn(async (_sql: string, [url]: string[]) => [{ n: usos[url] ?? 0 }]) };
        const config: any = { get: () => NUBE };
        return { limpieza: new LimpiezaDeFotos({ deleteImage } as any, dataSource, config), deleteImage, dataSource };
    };

    it('borra la foto que nadie más usa', async () => {
        const { limpieza, deleteImage } = armar({});
        expect(await limpieza.borrar([nuestra('a')])).toEqual({ borradas: 1, conservadas: 0 });
        expect(deleteImage).toHaveBeenCalledWith('products/a');
    });

    it('conserva la que otro producto sigue usando (variantes que comparten foto)', async () => {
        const { limpieza, deleteImage } = armar({ [nuestra('a')]: 1 });
        expect(await limpieza.borrar([nuestra('a')])).toEqual({ borradas: 0, conservadas: 1 });
        expect(deleteImage).not.toHaveBeenCalled();
    });

    it('conserva lo que no es nuestro y no repite una foto de la lista', async () => {
        const { limpieza, deleteImage } = armar({});
        const r = await limpieza.borrar(['https://otro.com/x.jpg', nuestra('b'), nuestra('b')]);
        expect(r).toEqual({ borradas: 1, conservadas: 1 });
        expect(deleteImage).toHaveBeenCalledTimes(1);
    });

    it('si Cloudinary falla no interrumpe y sigue con las demás', async () => {
        const { limpieza, deleteImage } = armar({});
        deleteImage.mockRejectedValueOnce(new Error('cloudinary caído'));
        const r = await limpieza.borrar([nuestra('a'), nuestra('b')]);
        expect(r).toEqual({ borradas: 1, conservadas: 1 });
    });
});
