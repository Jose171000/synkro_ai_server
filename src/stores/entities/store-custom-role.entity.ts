import { Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Store } from './store.entity';

/**
 * Rol personalizado de UNA tienda: un nombre y un conjunto de permisos (ver `permissions.ts` y docs/roles-de-tienda.md).
 * Los roles de fábrica (dueño, editor, lector) no viven aquí: están en el código y no se pueden modificar.
 *
 * Los permisos se guardan como lista de claves; al leerlos se descartan las que ya no existan y se completan las
 * dependencias, así que un permiso retirado del catálogo nunca queda dando acceso.
 */
@Entity('store_custom_roles')
export class StoreCustomRole {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => Store, { onDelete: 'CASCADE', nullable: false })
    store: Store;

    /** Único dentro de la tienda sin distinguir mayúsculas (índice en la migración). */
    @Column({ type: 'varchar', length: 40 })
    name: string;

    @Column({ type: 'jsonb', default: () => "'[]'" })
    permissions: string[];

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;
}
