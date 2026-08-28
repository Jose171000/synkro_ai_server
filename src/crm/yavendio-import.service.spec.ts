import { YavendioImportService } from './yavendio-import.service';

/**
 * El mapeo de conversaciones a etapas del embudo es la decisión de negocio
 * de esta integración. Estas pruebas la fijan: si alguien la cambia sin
 * querer, aquí se nota antes de que llegue a los prospectos reales.
 */

type FakeLead = Record<string, any>;

function makeService(existing: FakeLead[], conversations: any[]) {
    const saved: FakeLead[] = [...existing];

    const repo: any = {
        findOne: async ({ where }: any) =>
            saved.find(l => (where.externalKey ? l.externalKey === where.externalKey : l.id === where.id)) || null,
        create: (data: FakeLead) => ({ ...data }),
        save: async (lead: FakeLead) => {
            const i = saved.findIndex(l => l === lead || (lead.id && l.id === lead.id));
            if (i >= 0) saved[i] = lead; else saved.push(lead);
            return lead;
        },
        // Búsqueda por teléfono: aquí no hay Postgres, así que se simula.
        createQueryBuilder: () => ({
            where() { return this; },
            getOne: async () => null,
        }),
    };

    const sync: any = { getYavendioApiKey: async () => 'yv_live_v1_de_prueba' };
    const api: any = { listConversations: async () => conversations };

    return { service: new YavendioImportService(repo, sync, api), saved };
}

const conversation = (over: any = {}) => ({
    id: over.id || 'c1',
    // 'in' y no ??, para poder pasar null explícito y probar el caso vacío.
    customer: {
        name: 'name' in over ? over.name : 'Ana Torres',
        phone_number: 'phone' in over ? over.phone : '+51999111222',
    },
    last_message_preview: over.preview ?? null,
    last_message_direction: over.direction ?? null,
    sale_status: over.sale_status ?? null,
    updated_at: over.updated_at ?? '2026-08-20T10:00:00Z',
});

describe('importación de Yavendió al embudo', () => {
    it('una venta confirmada entra como ganado', async () => {
        const { service, saved } = makeService([], [conversation({ sale_status: 'positive', preview: 'Listo, lo tomo' })]);
        await service.import('admin-1');
        expect(saved[0].stage).toBe('ganado');
    });

    it('una venta descartada entra como perdido', async () => {
        const { service, saved } = makeService([], [conversation({ sale_status: 'negative' })]);
        await service.import('admin-1');
        expect(saved[0].stage).toBe('perdido');
    });

    it('una conversación con mensajes entra como contactado', async () => {
        const { service, saved } = makeService([], [conversation({ preview: 'Hola, te escribo por...', direction: 'outbound' })]);
        await service.import('admin-1');
        expect(saved[0].stage).toBe('contactado');
    });

    it('un contacto sin un solo mensaje entra como nuevo', async () => {
        const { service, saved } = makeService([], [conversation({})]);
        await service.import('admin-1');
        expect(saved[0].stage).toBe('nuevo');
    });

    it('avisa cuando te escribieron y no respondiste', async () => {
        const { service, saved } = makeService([], [conversation({ preview: '¿Sigue disponible?', direction: 'inbound' })]);
        await service.import('admin-1');
        expect(saved[0].notes).toContain('no hay respuesta');
        expect(saved[0].notes).toContain('¿Sigue disponible?');
    });

    it('guarda el origen y la clave para no duplicar', async () => {
        const { service, saved } = makeService([], [conversation({ id: 'abc-123' })]);
        await service.import('admin-1');
        expect(saved[0].origin).toBe('yavendio');
        expect(saved[0].source).toBe('yavendio');
        expect(saved[0].externalKey).toBe('yavendio:abc-123');
        expect(saved[0].lastContactAt).toBe('2026-08-20');
    });

    it('reimportar no duplica: actualiza el que ya existe', async () => {
        const existente = { id: 'l1', externalKey: 'yavendio:c1', stage: 'contactado', name: 'Ana Torres' };
        const { service, saved } = makeService([existente], [conversation({ preview: 'nuevo mensaje', direction: 'outbound' })]);
        const r = await service.import('admin-1');
        expect(r.created).toBe(0);
        expect(r.updated).toBe(1);
        expect(saved).toHaveLength(1);
    });

    it('NO revierte una etapa movida a mano', async () => {
        // Alguien avanzó el lead a "propuesta"; Yavendió solo sabe que hay
        // mensajes, así que diría "contactado". Debe mandar la persona.
        const existente = { id: 'l1', externalKey: 'yavendio:c1', stage: 'propuesta', name: 'Ana Torres' };
        const { service, saved } = makeService([existente], [conversation({ preview: 'hola', direction: 'outbound' })]);
        await service.import('admin-1');
        expect(saved[0].stage).toBe('propuesta');
    });

    it('pero un cierre confirmado por Yavendió sí manda', async () => {
        const existente = { id: 'l1', externalKey: 'yavendio:c1', stage: 'propuesta', name: 'Ana Torres' };
        const { service, saved } = makeService([existente], [conversation({ sale_status: 'positive' })]);
        await service.import('admin-1');
        expect(saved[0].stage).toBe('ganado');
    });

    it('con skipEmpty deja fuera las conversaciones sin mensajes', async () => {
        const { service, saved } = makeService([], [
            conversation({ id: 'vacia' }),
            conversation({ id: 'conmensajes', preview: 'hola', direction: 'outbound' }),
        ]);
        const r = await service.import('admin-1', { skipEmpty: true });
        expect(r.skipped).toBe(1);
        expect(r.created).toBe(1);
        expect(saved).toHaveLength(1);
    });

    it('en simulacro no escribe nada', async () => {
        const { service, saved } = makeService([], [conversation({ preview: 'hola' })]);
        const r = await service.import('admin-1', { dryRun: true });
        expect(r.created).toBe(1);
        expect(saved).toHaveLength(0);
    });

    it('omite una conversación sin nombre ni teléfono', async () => {
        const { service, saved } = makeService([], [conversation({ name: null, phone: null })]);
        const r = await service.import('admin-1');
        expect(r.skipped).toBe(1);
        expect(saved).toHaveLength(0);
    });
});
