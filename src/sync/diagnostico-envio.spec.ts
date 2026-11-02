import { camposDeCosto, lineaDeDiagnostico, nombresDeCampos, puedeDiagnosticar } from './diagnostico-envio';

describe('diagnóstico temporal del costo de envío', () => {
    const pedido = {
        id: 123,
        paid_amount: 45.9,
        total_amount: 35,
        buyer: { id: 9, nickname: 'juan', first_name: 'Juan', phone: { number: '999' } },
        shipping: { id: 77, cost: 10.9, receiver_address: { street_name: 'Av. Siempre Viva', city: { name: 'Lima' } } },
        payments: [{ shipping_cost: 10.9, total_paid_amount: 45.9, payer_email: 'a@b.c' }],
        comment: 'dejar con el portero',
    };

    it('muestra los campos de costo con su ruta y valor', () => {
        const campos = camposDeCosto(pedido);
        expect(campos).toEqual(expect.arrayContaining(['paid_amount=45.9', 'total_amount=35', 'shipping.cost=10.9', 'payments[0].shipping_cost=10.9', 'payments[0].total_paid_amount=45.9']));
    });

    it('nunca incluye datos personales: ni nombres, direcciones, teléfonos, correos ni comentarios', () => {
        const todo = lineaDeDiagnostico('ML', 'orden 123', pedido);
        for (const secreto of ['juan', 'Juan', '999', 'Av. Siempre Viva', 'Lima', 'a@b.c', 'portero']) expect(todo).not.toContain(secreto);
        expect(nombresDeCampos(pedido)).not.toContain('buyer');
        expect(nombresDeCampos(pedido)).toContain('shipping');
    });

    it('ignora los textos largos y limita el largo de cada línea', () => {
        expect(camposDeCosto({ shipping_note: 'x'.repeat(200) })).toEqual([]);
        const enorme = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`cost_${i}`, i]));
        expect(lineaDeDiagnostico('ML', 't', enorme).length).toBeLessThanOrEqual(1800);
    });

    it('en las pruebas no se activa (no cambia las llamadas de las demás)', () => {
        expect(puedeDiagnosticar('mercadolibre', 5)).toBe(false);
    });
});
