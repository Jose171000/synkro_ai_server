import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Index } from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Una tienda: la unidad a la que pertenecen las conexiones con canales y el
 * Ojo de Dios. Una cuenta puede crear varias, y otras personas entran a ellas
 * solo por invitación (ver StoreMember).
 */
@Entity('stores')
export class Store {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    /** Quien la creó. Es su dueño y el único que puede invitar o quitar gente. */
    @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
    @Index()
    owner: User;

    /**
     * Código del enlace público de solo lectura. Largo y aleatorio, nunca el
     * nombre ni el id de la tienda, para que no se pueda recorrer probando
     * tiendas. Nulo mientras el enlace no se haya activado.
     */
    @Column({ type: 'varchar', nullable: true, unique: true })
    publicToken: string | null;

    /** El enlace público solo responde si está activado. */
    @Column({ default: false })
    publicEnabled: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
