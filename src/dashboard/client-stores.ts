import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Store } from '../stores/entities/store.entity';
import { User } from '../users/entities/user.entity';
import { ClientProfile } from '../admin/entities/client-profile.entity';

/**
 * A qué cliente pertenece cada tienda. La agencia suele crear y configurar las
 * tiendas de sus clientes desde sus propias cuentas, así que el dueño de la
 * tienda no dice de quién es el negocio: hay que poder asignarlo.
 */

export type OrigenDeAtribucion = 'asignada' | 'dueno' | 'nombre';

export interface TiendaParaAtribuir {
    id: string;
    nombre: string;
    duenoId: string;
    duenoRol: string;
    /** Cliente que la agencia asignó a mano. */
    clienteAsignadoId: string | null;
}

export interface ClienteParaAtribuir {
    id: string;
    /** Nombres con los que se reconoce su negocio: razón social, empresa, nombre. */
    nombres: string[];
}

const normalizar = (s: string | null | undefined) =>
    (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Reglas, en este orden:
 *  1. La que la agencia asignó a mano.
 *  2. Si el dueño de la tienda es el propio cliente (una cuenta normal).
 *  3. Si el nombre de la tienda es el del negocio del cliente (sin tildes ni mayúsculas),
 *     siempre que lo reconozca un solo cliente.
 * Lo que no encaja en ninguna queda sin asignar: se sigue viendo en los totales
 * y se puede asignar desde la ficha del cliente.
 */
export function atribuirTiendas(
    tiendas: TiendaParaAtribuir[],
    clientes: ClienteParaAtribuir[],
): Map<string, { clienteId: string; origen: OrigenDeAtribucion }> {
    const resultado = new Map<string, { clienteId: string; origen: OrigenDeAtribucion }>();
    const idsDeClientes = new Set(clientes.map(c => c.id));

    // Nombre normalizado → cliente (null si lo comparten varios: no se adivina)
    const porNombre = new Map<string, string | null>();
    for (const c of clientes) {
        for (const nombre of new Set(c.nombres.map(normalizar).filter(Boolean))) {
            porNombre.set(nombre, porNombre.has(nombre) && porNombre.get(nombre) !== c.id ? null : c.id);
        }
    }

    for (const t of tiendas) {
        if (t.clienteAsignadoId) {
            resultado.set(t.id, { clienteId: t.clienteAsignadoId, origen: 'asignada' });
        } else if (idsDeClientes.has(t.duenoId) && t.duenoRol !== 'admin') {
            resultado.set(t.id, { clienteId: t.duenoId, origen: 'dueno' });
        } else {
            const porSuNombre = porNombre.get(normalizar(t.nombre));
            if (porSuNombre) resultado.set(t.id, { clienteId: porSuNombre, origen: 'nombre' });
        }
    }
    return resultado;
}

export interface MapaDeTiendas {
    tiendas: (TiendaParaAtribuir & { duenoEmail: string; clienteId: string | null; origen: OrigenDeAtribucion | null })[];
    /** tienda → cliente (solo las atribuidas) */
    clienteDe: Map<string, string>;
    /** cliente → ids de sus tiendas */
    tiendasDe: Map<string, string[]>;
}

@Injectable()
export class ClientStoresService {
    constructor(
        @InjectRepository(Store) private readonly stores: Repository<Store>,
        @InjectRepository(User) private readonly users: Repository<User>,
        @InjectRepository(ClientProfile) private readonly profiles: Repository<ClientProfile>,
    ) { }

    async mapa(): Promise<MapaDeTiendas> {
        const [tiendas, clientes, perfiles] = await Promise.all([
            this.stores.find({ relations: { owner: true, client: true }, order: { createdAt: 'ASC' } }),
            this.users.find({ where: [{ role: 'user' }, { role: 'moderator' }] }),
            this.profiles.find({ relations: { user: true } }),
        ]);
        const perfilDe = new Map(perfiles.map(p => [p.user?.id, p]));

        const para: TiendaParaAtribuir[] = tiendas.map(t => ({
            id: t.id,
            nombre: t.name,
            duenoId: t.owner.id,
            duenoRol: t.owner.role,
            clienteAsignadoId: t.client?.id ?? null,
        }));
        const atribucion = atribuirTiendas(
            para,
            clientes.map(c => ({
                id: c.id,
                nombres: [perfilDe.get(c.id)?.businessName ?? '', c.nameCompany ?? '', `${c.name ?? ''} ${c.lastName ?? ''}`],
            })),
        );

        const clienteDe = new Map<string, string>();
        const tiendasDe = new Map<string, string[]>();
        for (const [tiendaId, { clienteId }] of atribucion) {
            clienteDe.set(tiendaId, clienteId);
            tiendasDe.set(clienteId, [...(tiendasDe.get(clienteId) ?? []), tiendaId]);
        }

        return {
            tiendas: tiendas.map((t, i) => ({
                ...para[i],
                duenoEmail: t.owner.email,
                clienteId: atribucion.get(t.id)?.clienteId ?? null,
                origen: atribucion.get(t.id)?.origen ?? null,
            })),
            clienteDe,
            tiendasDe,
        };
    }

    /** Asigna una tienda a un cliente (o la deja sin asignar con null). */
    async asignar(tiendaId: string, clienteId: string | null) {
        const tienda = await this.stores.findOne({ where: { id: tiendaId } });
        if (!tienda) throw new NotFoundException('Tienda no encontrada');
        if (clienteId) {
            const cliente = await this.users.findOne({ where: { id: clienteId } });
            if (!cliente) throw new NotFoundException('Cliente no encontrado');
        }
        // update() y no save(): solo cambia esta columna.
        await this.stores.update(tiendaId, { client: clienteId ? ({ id: clienteId } as any) : null } as any);
        return { tiendaId, clienteId };
    }
}
