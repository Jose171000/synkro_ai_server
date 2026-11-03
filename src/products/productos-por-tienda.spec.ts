import { NotFoundException } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { ProductsService } from './products.service';

/**
 * Abrir, editar o usar la IA sobre un producto por su ID es acceso de la TIENDA, no de quien lo subió: un editor trabaja los
 * productos que subió el dueño. (El permiso ya se comprobó en la ruta.) Antes solo valía para quien lo había creado, sin mirar el rol.
 */
describe('productos por ID en la tienda activa', () => {
    const TIENDA = '1a2b3c4d-1111-4222-8333-444455556666';

    function servicio(encontrado: any) {
        const findOne: jest.Mock = jest.fn(async (..._args: any[]) => encontrado);
        const s: any = Object.create(ProductsService.prototype);
        s.productRepository = { findOne, save: jest.fn(async (p: any) => p), manager: { count: jest.fn(async () => 0) } };
        return { s: s as ProductsService, findOne };
    }

    it('con tienda busca por la tienda (de cualquiera) o por un producto viejo sin tienda que sea de quien pregunta', async () => {
        const { s, findOne } = servicio({ id: 'p1' });
        await expect(s.findOne('p1', 'editor-1', TIENDA)).resolves.toEqual({ id: 'p1' });
        expect(findOne).toHaveBeenCalledWith({
            where: [{ id: 'p1', store: { id: TIENDA } }, { id: 'p1', store: IsNull(), owner: { id: 'editor-1' } }],
        });
    });

    it('sin tienda (llamadas internas) se mantiene la regla de antes: solo el dueño del producto', async () => {
        const { s, findOne } = servicio({ id: 'p1' });
        await s.findOne('p1', 'dueno-1');
        expect(findOne).toHaveBeenCalledWith({ where: { id: 'p1', owner: { id: 'dueno-1' } } });
    });

    it('un producto de otra tienda no se encuentra', async () => {
        const { s } = servicio(null);
        await expect(s.findOne('ajeno', 'editor-1', TIENDA)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('editar un producto de la tienda funciona aunque lo haya creado otra persona', async () => {
        const producto: any = { id: 'p1', sku: 'A-1', name: 'Viejo', store: { id: TIENDA }, owner: { id: 'dueno-1' } };
        const { s } = servicio(producto);
        const r: any = await s.update('p1', { name: 'Nuevo' } as any, 'editor-1', TIENDA);
        expect(r.name).toBe('Nuevo');
    });

    it('al editar se busca con la tienda cargada (el SKU se valida dentro de ella)', async () => {
        const { s, findOne } = servicio({ id: 'p1', sku: 'A-1', store: { id: TIENDA } });
        await s.update('p1', { name: 'X' } as any, 'editor-1', TIENDA);
        expect(findOne.mock.calls[0][0]).toMatchObject({ relations: { store: true } });
    });
});
