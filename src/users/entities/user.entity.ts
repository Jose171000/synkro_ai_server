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

    @OneToMany(() => RefreshToken, refreshToken => refreshToken.user)
    refreshTokens: RefreshToken[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
