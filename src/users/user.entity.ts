import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity("Users")
export class User {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ unique: false, nullable: false })
    name: string;

    @CreateDateColumn({ nullable: false })
    nameCompany: string

    @Column({nullable: false, unique: true})
    cellPhone: string;
    
    @Column({nullable: false})
    country: string;

    @Column({nullable: false})
    lastName: string;

    @Column({nullable: false, unique: false})
    url: string;

    @Column({ unique: true })
    email: string;

    @Column()
    password: string;

    @Column({ default: 'user' }) // 'admin' o 'user'
    role: string;

    @CreateDateColumn()
    createdAt: Date;

}
