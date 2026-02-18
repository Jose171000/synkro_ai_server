import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Product } from './product.entity';

@Entity('product_images')
export class ProductImage {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    url: string;

    @ManyToOne(() => Product, (product) => product.images, { onDelete: 'CASCADE' })
    product: Product;
}
