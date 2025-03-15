import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class Product {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ nullable: false })
    name: string;
    @Column({ nullable: false, unique: true })
    sku: string;
    @Column({ nullable: false })
    description: string;
}