import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Index } from 'typeorm';
import { User } from '../../../users/entities/user.entity';

/**
 * Un envío en lote a Falabella.
 *
 * Publicar en Falabella no es inmediato: se manda un lote de productos, la
 * API responde un identificador (el "feed") y el resultado real —cuántos
 * entraron, cuáles fallaron y por qué— llega después. Esta tabla guarda ese
 * identificador para poder consultar el estado más tarde y saber qué pasó
 * con cada producto.
 */
@Entity('marketplace_feeds')
export class MarketplaceFeed {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ default: 'falabella' })
    marketplace: string;

    /** El identificador que devuelve Falabella (un UUID). */
    @Column()
    @Index()
    externalFeedId: string;

    /** ProductCreate, ProductUpdate, UpdateStock... */
    @Column()
    action: string;

    /** SKUs incluidos en el lote, para saber a qué producto corresponde cada error. */
    @Column('simple-array', { nullable: true })
    skus: string[];

    /** pending → processing → finished | error */
    @Column({ default: 'pending' })
    status: string;

    @Column('int', { default: 0 })
    totalRecords: number;

    @Column('int', { default: 0 })
    processedRecords: number;

    @Column('int', { default: 0 })
    failedRecords: number;

    /** Errores devueltos por Falabella, por SKU. */
    @Column({ type: 'jsonb', nullable: true })
    errors: { sku?: string; message: string }[] | null;

    @ManyToOne(() => User)
    owner: User;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
