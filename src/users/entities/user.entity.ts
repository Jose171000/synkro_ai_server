import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { UserRole } from '../user-role';

@Entity('users')
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;
    
    @Column()
    lastName: string;

    @Column({ unique: true })
    email: string;

    @Column()
    password: string;

    @Column({ nullable: true })
    nameCompany: string

    @Column({nullable: true})
    cellPhone: string;
    
    @Column({nullable: true})
    country: string;

    @Column({nullable: true})
    url: string;

    @Column({type: 'varchar', length: 20, default: UserRole.USER})
    role: string;

    @Column({ default: true})
    isActive: boolean;

    /**
     * Secciones de la app a las que el usuario tiene acceso.
     * null / vacío = acceso completo (comportamiento por defecto).
     * Valores: dashboard | products | ai-products | marketplaces | analytics | settings
     */
    @Column('simple-array', { nullable: true })
    allowedSections: string[] | null;

    /**
     * Modo revisión: cuando está encendido, los cambios de precio y stock no
     * se envían a los marketplaces hasta que alguien los apruebe.
     */
    @Column({ default: true })
    syncReviewMode: boolean;

    /**
     * true cuando la cuenta se creó a partir de una invitación a una tienda.
     * Esas cuentas entran a tiendas ajenas pero no pueden crear tiendas propias:
     * solo quien se registró por su cuenta es dueño de su espacio.
     */
    @Column({ default: false })
    createdFromInvitation: boolean;

    @OneToMany(() => RefreshToken, refreshToken => refreshToken.user)
    refreshTokens: RefreshToken[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
