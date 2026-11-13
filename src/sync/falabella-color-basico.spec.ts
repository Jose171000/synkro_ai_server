import { SyncService } from './sync.service';

const campo = (name: string, over: any = {}) => ({ name, feedName: name, label: name, isMandatory: true, inputType: 'dropdown', options: [], ...over });
// «Color» tiene muchas opciones; «Color básico» solo unas pocas (sin «Leopardo»).
const CATEGORIA = [
    campo('color_basico', { label: 'Color básico', options: ['Beige', 'Negro', 'Multicolor'] }),
    campo('color', { label: 'Color', options: ['Beige', 'Negro', 'Leopardo', 'Multicolor'] }),
];

describe('Falabella: el color de la variante no vale para un campo de colores básicos que no lo tiene', () => {
    const servicio: any = Object.create(SyncService.prototype);
    const ficha = (aiAttributes: any, color: string) => ({
        sku: 'BAL-37', name: 'Ballerinas', aiTitle: 'Ballerinas', price: 250, stock: 1, images: [{ url: 'https://i/1.jpg' }], description: 'Ballerinas de cuero',
        packageWidth: 18, packageLength: 29, packageHeight: 9, packageWeight: 1, marketplaceIds: { falabella_category_id: '4' },
        aiAttributes: { brand: 'JOLI JOLI', ...aiAttributes }, variantValues: { Color: color, Talla: '37' },
    });

    it('«Leopardo» queda en «Color» y el color básico usa la opción válida que ya tenía el producto', () => {
        const r: any = servicio.toFalabellaInput(ficha({ color_basico: 'Beige', color: 'Beige' }, 'Leopardo'), 'active', CATEGORIA);
        expect('reason' in r).toBe(false);
        expect(r.input.extraAttributes.color).toBe('Leopardo');
        expect(r.input.extraAttributes.color_basico).toBe('Beige');
    });

    it('sin una opción válida de respaldo sigue pidiendo el dato en vez de inventarlo', () => {
        const r: any = servicio.toFalabellaInput(ficha({}, 'Leopardo'), 'active', CATEGORIA);
        expect(r.reason).toMatch(/Color básico/);
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
