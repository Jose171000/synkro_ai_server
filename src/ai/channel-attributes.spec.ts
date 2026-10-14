import { ChannelAttributesService } from './channel-attributes.service';

const crudos = [
    { id: 'COLOR', name: 'Color', tags: { required: true }, values: [{ name: 'Azul' }] },
    { id: 'MATERIAL', name: 'Material', tags: {} },
];

function construir(opts: { guardadas?: any[]; meliFalla?: boolean } = {}) {
    const filas: any[] = [...(opts.guardadas ?? [])];
    const categories: any = {
        findOne: jest.fn(async ({ where }: any) => filas.find((f) => f.marketplace === where.marketplace && f.categoryId === where.categoryId) ?? null),
        update: jest.fn(async ({ id }: any, cambios: any) => { Object.assign(filas.find((f) => f.id === id), cambios, { updatedAt: new Date() }); }),
        create: jest.fn((x: any) => x),
        save: jest.fn(async (x: any) => {
            const previa = filas.find((f) => f.id === x.id);
            if (previa) Object.assign(previa, x); else filas.push({ id: `n${filas.length}`, updatedAt: new Date(), ...x });
            return x;
        }),
    };
    const meli: any = {
        getCategoryAttributes: jest.fn(async () => { if (opts.meliFalla) throw new Error('caído'); return crudos; }),
        getCategory: jest.fn(async () => ({ id: 'MPE9', name: 'Sábanas', path_from_root: [{ name: 'Hogar' }, { name: 'Cama' }, { name: 'Sábanas' }] })),
        predictCategory: jest.fn(),
    };
    const seeder: any = { generateEmbedding: jest.fn(async () => [0.1, 0.2]) };
    const service = new ChannelAttributesService(meli, {} as any, {} as any, seeder, {} as any, categories);
    return { service, filas, meli, seeder, categories };
}

describe('el catálogo aprende con cada producto', () => {
    it('una categoría nueva se guarda con su ruta, todos sus atributos y su vector', async () => {
        const { service, filas, meli } = construir();
        const r = await service.requisitos('mercadolibre', 'MPE9', 'u1', { titulo: 'Juego de sábanas turquesa', palabras: ['sábanas', 'cama'] });

        expect(r!.map((a) => a.name)).toEqual(['COLOR', 'MATERIAL']);
        expect(meli.getCategoryAttributes).toHaveBeenCalledTimes(1);
        expect(filas).toHaveLength(1);
        expect(filas[0]).toMatchObject({ marketplace: 'mercadolibre', categoryId: 'MPE9', name: 'Sábanas', embedding: [0.1, 0.2] });
        expect(filas[0].labelText).toContain('Hogar Cama Sábanas');
        expect(filas[0].labelText).toContain('juego de sábanas turquesa');
        expect(filas[0].requiredAttributes.map((a: any) => a.name)).toEqual(['COLOR', 'MATERIAL']);
    });

    it('la segunda vez no pregunta al canal y aprende las palabras nuevas', async () => {
        const { service, filas, meli, seeder } = construir();
        await service.requisitos('mercadolibre', 'MPE9', 'u1', { titulo: 'Sábanas turquesa', palabras: [] });
        meli.getCategoryAttributes.mockClear();
        seeder.generateEmbedding.mockClear();

        const r = await service.requisitos('mercadolibre', 'MPE9', 'u1', { titulo: 'Sábanas bamboo', palabras: ['bamboo'] });

        expect(meli.getCategoryAttributes).not.toHaveBeenCalled();
        expect(r!.map((a) => a.name)).toEqual(['COLOR', 'MATERIAL']);
        expect(filas[0].labelText).toContain('bamboo');
        expect(seeder.generateEmbedding).toHaveBeenCalledTimes(1);
    });

    it('si no hay nada nuevo que aprender no recalcula el vector', async () => {
        const { service, seeder } = construir();
        await service.requisitos('mercadolibre', 'MPE9', 'u1', { titulo: 'Sábanas', palabras: ['cama'] });
        seeder.generateEmbedding.mockClear();
        await service.requisitos('mercadolibre', 'MPE9', 'u1', { titulo: 'Sábanas', palabras: ['cama'] });
        expect(seeder.generateEmbedding).not.toHaveBeenCalled();
    });

    it('si el canal falla usa lo aprendido aunque esté vencido, y sin nada devuelve null', async () => {
        const vieja = { id: 'v1', marketplace: 'mercadolibre', categoryId: 'MPE9', labelText: 'x', updatedAt: new Date(Date.now() - 90 * 86_400_000), requiredAttributes: [{ name: 'COLOR', description: 'Color', example: '', isRequired: true }] };
        const conViejo = construir({ guardadas: [vieja], meliFalla: true });
        expect((await conViejo.service.requisitos('mercadolibre', 'MPE9'))!.map((a) => a.name)).toEqual(['COLOR']);

        const vacio = construir({ meliFalla: true });
        expect(await vacio.service.requisitos('mercadolibre', 'MPE9')).toBeNull();
        expect(vacio.filas).toHaveLength(0);
    });

    it('guardar lo aprendido nunca rompe la creación del producto', async () => {
        const { service, categories } = construir();
        categories.save.mockRejectedValue(new Error('clave duplicada'));
        await expect(service.requisitos('mercadolibre', 'MPE9', 'u1', { titulo: 'x y z' })).resolves.toHaveLength(2);
    });
});
