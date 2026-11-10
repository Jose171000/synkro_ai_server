import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn, Unique } from 'typeorm';

/**
 * Una lista cerrada de valores de un canal (Ripley: los 238 colores, los 2.187 tipos de producto…). Se guarda UNA vez y cada
 * atributo de categoría la referencia por su código, en vez de repetirla dentro de miles de categorías.
 */
@Entity('marketplace_value_lists')
@Unique('UQ_value_list_marketplace_code', ['marketplace', 'code'])
export class MarketplaceValueList {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    marketplace: string;

    /** Código de la lista en el canal (p. ej. «color_80», «tipo_product»). */
    @Column()
    code: string;

    @Column({ type: 'text', nullable: true })
    label: string | null;

    /** Los valores permitidos, tal como el canal los pide escritos. */
    @Column({ type: 'jsonb', default: () => `'[]'` })
    values: string[];

    @UpdateDateColumn()
    updatedAt: Date;
}
