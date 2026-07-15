import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Unique } from 'typeorm';
import { User } from 'src/users/entities/user.entity';

/**
 * Stores the OAuth credentials that link a Synkro user with their
 * seller account on an external marketplace (Mercado Libre, Shopify...).
 * One row per (user, marketplace).
 */
@Entity('marketplace_connections')
@Unique('UQ_connection_marketplace_owner', ['marketplace', 'owner'])
export class MarketplaceConnection {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    marketplace: string; // 'mercadolibre' | 'shopify' | 'amazon'

    // Seller ID on the external platform (e.g. Mercado Libre user id)
    @Column()
    externalUserId: string;

    @Column({ nullable: true })
    externalNickname: string;

    @Column('text')
    accessToken: string;

    @Column('text', { nullable: true })
    refreshToken: string;

    // When the current accessToken stops being valid
    @Column({ type: 'timestamptz' })
    expiresAt: Date;

    @Column({ default: 'active' })
    status: 'active' | 'revoked' | 'error';

    @ManyToOne(() => User)
    owner: User;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
