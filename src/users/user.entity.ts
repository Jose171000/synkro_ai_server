import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity()
export class User {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ unique: false, nullable: false })
    name: string;

    @Column({nullable: false})
    lastName: string;

    @Column({nullable: false})
    cellphone: string;

    @Column({nullable: false, unique: true})
    url: string;

    @Column({ unique: true })
    email: string;

    @Column()
    password: string;

    @Column({ default: 'user' }) // 'admin' o 'user'
    role: string;

    @CreateDateColumn()
    createdAt: Date;

    @CreateDateColumn({ nullable: false })
    nameCompany: string
}
