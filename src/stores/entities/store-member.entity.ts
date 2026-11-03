import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Unique } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Store } from './store.entity';
import { StoreCustomRole } from './store-custom-role.entity';

/** owner: todo · editor: propone cambios · viewer: solo mira. */
export type StoreRole = 'owner' | 'editor' | 'viewer';

/** Orden de poder, para comparar «¿tiene al menos este rol?». */
export const STORE_ROLE_RANK: Record<StoreRole, number> = { viewer: 1, editor: 2, owner: 3 };

/** Quién puede entrar a una tienda y con qué rol. Es la única vía de acceso. */
@Entity('store_members')
@Unique('UQ_store_member', ['store', 'user'])
export class StoreMember {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => Store, { onDelete: 'CASCADE', nullable: false })
    store: Store;

    @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
    user: User;

    /** Rol de fábrica. Con rol personalizado queda en «viewer» (el de menos poder); los permisos reales son los del rol personalizado. */
    @Column({ type: 'varchar', length: 10 })
    role: StoreRole;

    /** Rol personalizado de la tienda, si tiene uno. Un rol en uso no se puede borrar. */
    @ManyToOne(() => StoreCustomRole, { onDelete: 'RESTRICT', nullable: true })
    customRole: StoreCustomRole | null;

    @CreateDateColumn()
    createdAt: Date;
}
