import { SyncService } from './sync.service';

const campo = (name: string, over: any = {}) => ({ name, feedName: name, label: name, isMandatory: true, inputType: 'dropdown', options: [], ...over });
// «Color» tiene muchas opciones; «Color básico» solo unas pocas (sin «Leopardo»).
const CATEGORIA = [
    campo('color_basico', { label: 'Color básico', options: ['Beige', 'Negro', 'Multicolor'] }),
    campo('color', { label: 'Color', options: ['Beige', 'Negro', 'Leopardo', 'Multicolor'] }),
];

describe('Falabella: un color sin opción en «Color básico» no se rellena distinto en cada talla', () => {
    const servicio: any = Object.create(SyncService.prototype);
    // Cada talla trae SU color básico guardado (la IA los llenó por separado y no coinciden): no debe usarse.
    const ficha = (aiAttributes: any, color: string, talla: string) => ({
        sku: `BAL-${talla}`, name: 'Ballerinas', aiTitle: 'Ballerinas', price: 250, stock: 1, images: [{ url: 'https://i/1.jpg' }], description: 'Ballerinas de cuero',
        packageWidth: 18, packageLength: 29, packageHeight: 9, packageWeight: 1, marketplaceIds: { falabella_category_id: '4' },
        aiAttributes: { brand: 'JOLI JOLI', ...aiAttributes }, variantValues: { Color: color, Talla: talla },
    });

    it('sin una opción confirmada para ese color, el dato queda pendiente (no se usa lo guardado de cada talla)', () => {
        for (const guardado of ['Beige', 'Café']) {
            const r: any = servicio.toFalabellaInput(ficha({ color_basico: guardado, color: guardado }, 'Leopardo', '35'), 'active', CATEGORIA);
            expect(r.reason).toContain('Color básico (valor no válido)');
        }
    });

    it('con la opción confirmada para ese dato, todas las tallas del color salen con la MISMA opción', () => {
        const ajustes = { falabella: { 'color@color basico': { leopardo: 'Beige' } } };
        const a: any = servicio.toFalabellaInput(ficha({ color_basico: 'Beige', color: 'Beige', _ajustes: ajustes }, 'Leopardo', '35'), 'active', CATEGORIA);
        const b: any = servicio.toFalabellaInput(ficha({ color_basico: 'Café', color: 'Café', _ajustes: ajustes }, 'Leopardo', '36'), 'active', CATEGORIA);
        expect('reason' in a).toBe(false);
        expect(a.input.extraAttributes.color_basico).toBe('Beige');
        expect(b.input.extraAttributes.color_basico).toBe('Beige');
        expect(a.input.extraAttributes.color).toBe(b.input.extraAttributes.color);
    });
});

describe('Falabella: un ajuste de color elegido para «Color» se lleva a la lista de «Color básico»', () => {
    const servicio: any = Object.create(SyncService.prototype);
    const categoria = [
        campo('color_basico', { label: 'Color básico', options: ['Beige', 'Café', 'Negro'] }),
        campo('color', { label: 'Color', options: ['Beige', 'Café', 'Café Oscuro', 'Café Claro', 'Negro'] }),
    ];
    const ficha = (valor: string, ajuste: string) => ({
        sku: 'BAL-35', name: 'Ballerinas', aiTitle: 'Ballerinas', price: 250, stock: 1, images: [{ url: 'https://i/1.jpg' }], description: 'Ballerinas de cuero',
        packageWidth: 18, packageLength: 29, packageHeight: 9, packageWeight: 1, marketplaceIds: { falabella_category_id: '4' },
        // El ajuste confirmado por la persona (clase color) vale para los dos datos; el producto NO trae un color básico de respaldo.
        aiAttributes: { brand: 'JOLI JOLI', color_basico: valor, color: valor, _ajustes: { falabella: { color: { [valor.toLowerCase()]: ajuste } } } },
        variantValues: { Color: valor, Talla: '35' },
    });

    it('«Leopardo» → «Café Oscuro» en «Color» y «Café» (la más cercana de su lista) en «Color básico»', () => {
        const r: any = servicio.toFalabellaInput(ficha('Leopardo', 'Café Oscuro'), 'active', categoria);
        expect('reason' in r).toBe(false);
        expect(r.input.extraAttributes.color).toBe('Café Oscuro');
        expect(r.input.extraAttributes.color_basico).toBe('Café');
    });
});
