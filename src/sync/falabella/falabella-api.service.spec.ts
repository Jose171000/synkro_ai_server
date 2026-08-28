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
