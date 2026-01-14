import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('refresh_tokens')
export class RefreshToken {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    token: string;

    @Column()
    expiresAt: Date;

    @Column({ default: false})
    isRevoked: boolean;

    @ManyToOne(()=> User, user =>user.refreshTokens, {onDelete: 'CASCADE'})
    user: User;

    @CreateDateColumn()
    createdAt: Date;

}