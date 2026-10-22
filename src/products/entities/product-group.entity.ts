import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, OneToMany } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Store } from '../../stores/entities/store.entity';
import { Product } from './product.entity';

/** Un eje de variación del grupo (Color, Talla, Personaje…) y los valores que se venden. */
export interface EjeDeVariacion {
    name: string;
    values: string[];
}

/**
 * Un producto con variantes. Cada variante es un producto normal (con su SKU, precio, stock y fotos) que apunta a este
 * grupo por `groupId` y guarda sus valores en `variantValues` (ej. {Color:'Rojo', Talla:'M'}). Un producto sin grupo se
 * comporta como siempre: es un grupo de una sola variante implícito.
 *
 * `parentSku` es el código del grupo (en Falabella se envía como ParentSku). No es el SKU de ninguna variante, salvo
 * cuando un producto ya existente se convierte en grupo: entonces su SKU pasa a ser el código del grupo.
 */
@Entity('product_groups')
export class ProductGroup {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column()
    parentSku: string;

    @Column({ type: 'jsonb', default: () => "'[]'" })
    axes: EjeDeVariacion[];

    @ManyToOne(() => User)
    owner: User;

    @ManyToOne(() => Store, { onDelete: 'SET NULL', nullable: true })
    store: Store | null;

    @OneToMany(() => Product, (product) => product.group)
    variants: Product[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
