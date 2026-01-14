import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne } from "typeorm";
import { User } from "src/users/entities/user.entity";

@Entity('products')
export class Product {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column({ unique: true })
    sku: string;

    @Column('text')
    description: string;

    // Campos generados por IA
    @Column({ nullable: true })
    aiTitle: string;

    @Column('text', { nullable: true })
    aiDescription: string;

    @Column('simple-array', { nullable: true })
    aiKeywords: string[];

    @Column({
        type: 'nvarchar',
        length: 'MAX',
        nullable: true,
        transformer: {
            to: (value: any) => value ? JSON.stringify(value) : null,
            from: (value: string) => value ? JSON.parse(value) : null,
        }
    })
    aiAttributes: Record<string, any>;

    // Categorización
    @Column({ nullable: true })
    category: string;

    @Column({ nullable: true })
    subCategory: string;

    // Precio e inventario
    @Column('decimal', { precision: 10, scale: 2, nullable: true })
    price: number;

    @Column({ default: 0 })
    stock: number;

    // Imágenes
    @Column('simple-array', { nullable: true })
    images: string[];

    // Marketplace sincronizados
    // @Column('jsonb', { nullable: true })
    // marketplaceIds: Record<string, string>;  // { mercadolibre: 'MLA123', amazon: 'ASIN456' }

    @Column({
        type: 'nvarchar',
        length: 'MAX',
        nullable: true,
        transformer: {
            to: (value: any) => value ? JSON.stringify(value) : null,
            from: (value: string) => value ? JSON.parse(value) : null,
        }
    })
    marketplaceIds: Record<string, string>;


    @Column('simple-array', { nullable: true })
    targetMarketplaces: string[]; // ['mercadolibre', 'amazon']

    // Estado
    @Column({ default: 'draft' })
    status: 'draft' | 'pending' | 'synced' | 'error';

    @ManyToOne(() => User)
    owner: User;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

}