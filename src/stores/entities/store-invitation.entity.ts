import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Store } from './store.entity';
import { StoreRole } from './store-member.entity';

/**
 * Invitación a una tienda por correo.
 *
 * Del token que viaja en el enlace solo se guarda su hash: quien tenga acceso
 * a la base de datos no puede reconstruir un enlace válido.
 */
@Entity('store_invitations')
export class StoreInvitation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => Store, { onDelete: 'CASCADE', nullable: false })
    store: Store;

    /** Siempre en minúsculas. La invitación solo la puede aceptar ese correo. */
    @Column()
    @Index()
    email: string;

    @Column({ type: 'varchar', length: 10 })
    role: Exclude<StoreRole, 'owner'>;

    @Column()
    @Index({ unique: true })
    tokenHash: string;

    @Column({ type: 'timestamptz' })
    expiresAt: Date;

    @Column({ type: 'timestamptz', nullable: true })
    acceptedAt: Date | null;

    @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
    invitedBy: User;

    @CreateDateColumn()
    createdAt: Date;
}
