import { FalabellaApiService } from './falabella-api.service';

/**
 * Comprobado contra la API real de Falabella: GetBrands responde el catálogo
 * completo aunque la API key sea inventada, porque es un catálogo global y no
 * verifica la firma. GetProducts sí la verifica (E007: Signature mismatch).
 *
 * Esta prueba existe para que nadie "simplifique" la validación volviendo a
 * GetBrands: se vería igual de bien y aceptaría credenciales incorrectas.
 */
describe('validación de credenciales de Falabella', () => {
    const credenciales = { userId: 'vendedor@ejemplo.com', apiKey: 'clave' };

    it('comprueba contra un endpoint del vendedor, nunca contra el catálogo global', async () => {
        const service = new FalabellaApiService();
        const llamadas: string[] = [];
        jest.spyOn(service, 'call').mockImplementation(async (_c, action) => {
            llamadas.push(action);
            return {} as any;
        });

        await service.verifyCredentials(credenciales);

        expect(llamadas).toEqual(['GetProducts']);
        expect(llamadas).not.toContain('GetBrands'); // no valida la firma
    });

    it('pide un solo producto: la comprobación debe ser barata', async () => {
        const service = new FalabellaApiService();
        const spy = jest.spyOn(service, 'call').mockResolvedValue({} as any);

        await service.verifyCredentials(credenciales);

        expect(spy).toHaveBeenCalledWith(credenciales, 'GetProducts', { Limit: 1, Offset: 0 });
    });

    it('deja pasar el error si Falabella rechaza la firma', async () => {
        const service = new FalabellaApiService();
        jest.spyOn(service, 'call').mockRejectedValue(new Error('E007 Login failed. Signature mismatch'));

        await expect(service.verifyCredentials(credenciales)).rejects.toThrow(/Signature mismatch/);
    });
});

/**
 * Falabella manda DOS nombres por atributo y son distintos:
 *   Name     = 'condition_type'  → identifica el atributo
 *   FeedName = 'ConditionType'   → es la etiqueta literal del XML
 *
 * Confundirlos hace que la validación reclame datos que sí se están
 * enviando, y que los atributos propios de la categoría viajen con el
 * nombre equivocado. Pasó de verdad contra la API real.
 */
describe('atributos de categoría', () => {
    const credenciales = { userId: 'vendedor@ejemplo.com', apiKey: 'clave' };

    const respuesta = {
        Attribute: [
            { Name: 'condition_type', FeedName: 'ConditionType', Label: 'Condición del producto', isMandatory: '1', InputType: 'dropdown',
              Options: { Option: [{ Name: 'Nuevo' }, { Name: 'Open Box' }] } },
            { Name: 'tipo_automotriz', FeedName: 'TipoAutomotriz', Label: 'Tipo automotriz', isMandatory: '1', InputType: 'multiselect' },
            { Name: 'name_en', FeedName: 'NameEn', Label: 'Nombre en inglés', isMandatory: '0', InputType: 'textfield' },
        ],
    };

    function servicio() {
        const s = new FalabellaApiService();
        jest.spyOn(s, 'call').mockResolvedValue(respuesta as any);
        return s;
    }

    it('conserva por separado el nombre técnico y la etiqueta XML', async () => {
        const attrs = await servicio().getCategoryAttributes(credenciales, 2789);
        expect(attrs[0].name).toBe('condition_type');
        expect(attrs[0].feedName).toBe('ConditionType');
        expect(attrs[1].name).toBe('tipo_automotriz');
        expect(attrs[1].feedName).toBe('TipoAutomotriz');
    });

    it('distingue los obligatorios de los opcionales', async () => {
        const attrs = await servicio().getCategoryAttributes(credenciales, 2789);
        expect(attrs.filter(a => a.isMandatory).map(a => a.name))
            .toEqual(['condition_type', 'tipo_automotriz']);
    });

    it('trae el nombre en castellano, que es el que se le muestra a una persona', async () => {
        const attrs = await servicio().getCategoryAttributes(credenciales, 2789);
        expect(attrs[0].label).toBe('Condición del producto');
    });

    it('recoge las opciones cuando el atributo es una lista cerrada', async () => {
        const attrs = await servicio().getCategoryAttributes(credenciales, 2789);
        expect(attrs[0].options).toEqual(['Nuevo', 'Open Box']);
        expect(attrs[1].options).toEqual([]);
    });

    it('no repite la consulta para la misma categoría', async () => {
        const s = servicio();
        await s.getCategoryAttributes(credenciales, 2789);
        await s.getCategoryAttributes(credenciales, 2789);
        expect(s.call).toHaveBeenCalledTimes(1);
    });
});
