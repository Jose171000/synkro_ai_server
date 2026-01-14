import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('password_resets')
export class PasswordReset {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    token: string;

    @Column()
    expiresAt: Date;

    @Column({ default: false})
    isUsed: boolean;

    @ManyToOne(()=> User, {onDelete: 'CASCADE'})
    user: User;

    @CreateDateColumn()
    createdAt: Date;
}