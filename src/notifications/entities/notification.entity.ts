import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, Index } from 'typeorm';
import { User } from '../../users/entities/user.entity';

/** Qué originó el aviso. Sirve para agrupar y para elegir el icono. */
export type NotificationType =
    | 'sale'              // entró una venta
    | 'publish'           // una publicación salió bien
    | 'publish-error'     // una publicación falló o fue rechazada
    | 'connection'        // una cuenta de marketplace se cayó o se reconectó
    | 'low-stock'         // un producto publicado se está agotando
    | 'import'            // una importación o carga masiva terminó
    | 'system';           // avisos de la plataforma

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

/**
 * Un aviso dirigido a una cuenta concreta.
 *
 * Antes esto no existía: la campana del menú mostraba tres avisos escritos a
 * mano en el código del frontend, iguales para todos y sin relación con nada
 * real. Ahora cada cosa que ocurre en una cuenta —una venta, una publicación
 * rechazada, una conexión caída— deja un registro que su dueño puede ver.
 */
@Entity('notifications')
@Index(['owner', 'read'])
export class Notification {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 20 })
    type: NotificationType;

    @Column({ type: 'varchar', length: 10, default: 'info' })
    severity: NotificationSeverity;

    @Column()
    title: string;

    @Column('text')
    body: string;

    /** El canal implicado, si lo hay: 'mercadolibre', 'falabella', 'yavendio'. */
    @Column({ nullable: true })
    marketplace: string;

    /**
     * Datos sueltos del suceso (id de producto, de pedido, SKU...). Permite
     * que el frontend lleve al usuario al sitio correcto sin inventar rutas.
     */
    @Column({ type: 'jsonb', nullable: true })
    meta: Record<string, any> | null;

    @Column({ default: false })
    read: boolean;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    owner: User;

    @CreateDateColumn()
    createdAt: Date;
}
