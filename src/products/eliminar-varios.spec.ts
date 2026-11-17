import { NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';

describe('eliminar varios productos', () => {
    const servicio = () => new ProductsService({} as any, {} as any, {} as any);

    it('elimina cada uno y un fallo no frena a los demás', async () => {
        const s = servicio();
        const remove = jest.spyOn(s, 'remove').mockImplementation(async (id: string) => {
            if (id === 'b') throw new NotFoundException('Producto no encontrado');
            return {} as any;
        });
        const r = await s.removeMany(['a', 'b', 'c', 'a'], 'u1', 's1');
        expect(remove).toHaveBeenCalledTimes(3); // 'a' repetido cuenta una sola vez
        expect(r).toEqual({ eliminados: 2, omitidos: [{ id: 'b', motivo: 'Producto no encontrado' }] });
    });

    it('con una lista vacía no hace nada', async () => {
        const s = servicio();
        const remove = jest.spyOn(s, 'remove');
        expect(await s.removeMany([], 'u1', 's1')).toEqual({ eliminados: 0, omitidos: [] });
        expect(remove).not.toHaveBeenCalled();
    });
});
