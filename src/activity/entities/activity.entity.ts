import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Tablas del registro de actividad (ver docs/actividad-de-usuarios.md). No guardan contenido: solo etiquetas de pantallas y
 * elementos, y cuándo. Los roles se copian en cada fila para poder filtrar por el rol que la persona tenía en ese momento.
 */

/** Una visita a la plataforma (una pestaña abierta). El navegador genera su identificador. */
@Entity('activity_sessions')
@Index('IDX_activity_sessions_user', ['userId', 'startedAt'])
@Index('IDX_activity_sessions_started', ['startedAt'])
export class ActivitySession {
    @PrimaryColumn('uuid')
    id: string;

    @Column('uuid')
    userId: string;

    @Column({ type: 'uuid', nullable: true })
    storeId: string | null;

    @Column({ type: 'varchar', length: 20 })
    platformRole: string;

    @Column({ type: 'varchar', length: 10, default: '' })
    storeRole: string;

    @Column({ type: 'varchar', length: 12, default: 'escritorio' })
    device: string;

    @Column({ type: 'timestamptz' })
    startedAt: Date;

    @Column({ type: 'timestamptz' })
    lastSeenAt: Date;

    /** Segundos con la pestaña visible y actividad (suma de los «ping»). */
    @Column({ type: 'int', default: 0 })
    activeSeconds: number;
}

/** Cada vista de una sección, clic en un elemento, acción en el servidor o latido de actividad. Se conserva 90 días. */
@Entity('activity_events')
@Index('IDX_activity_events_user_at', ['userId', 'at'])
@Index('IDX_activity_events_at', ['at'])
@Index('IDX_activity_events_screen', ['screen', 'type'])
export class ActivityEvent {
    @PrimaryGeneratedColumn('increment', { type: 'bigint' })
    id: string;

    @Column('uuid')
    userId: string;

    @Column({ type: 'uuid', nullable: true })
    storeId: string | null;

    @Column({ type: 'uuid', nullable: true })
    sessionId: string | null;

    @Column({ type: 'timestamptz' })
    at: Date;

    /** view · click · ping (del navegador) · action · login (del servidor). */
    @Column({ type: 'varchar', length: 10 })
    type: string;

    @Column({ type: 'varchar', length: 60 })
    screen: string;

    /** Elemento tocado (solo en los clics). */
    @Column({ type: 'varchar', length: 80, nullable: true })
    element: string | null;

    /** Acción hecha en el servidor, con nombre legible (solo en las acciones). */
    @Column({ type: 'varchar', length: 120, nullable: true })
    action: string | null;

    /** Posición del clic y del elemento dentro de la pantalla, en milésimas. */
    @Column({ type: 'smallint', nullable: true }) x: number | null;
    @Column({ type: 'smallint', nullable: true }) y: number | null;
    @Column({ type: 'smallint', nullable: true }) ex: number | null;
    @Column({ type: 'smallint', nullable: true }) ey: number | null;
    @Column({ type: 'smallint', nullable: true }) ew: number | null;
    @Column({ type: 'smallint', nullable: true }) eh: number | null;

    /** Segundos de actividad (en los «ping»). */
    @Column({ type: 'smallint', nullable: true })
    value: number | null;

    @Column({ type: 'varchar', length: 20 })
    platformRole: string;

    @Column({ type: 'varchar', length: 10, default: '' })
    storeRole: string;
}

/** Resumen por día de vistas, clics y acciones por pantalla y elemento. Se conserva 2 años. */
@Entity('activity_daily')
@Unique('UQ_activity_daily', ['day', 'userId', 'type', 'screen', 'element', 'platformRole', 'storeRole'])
@Index('IDX_activity_daily_day', ['day'])
@Index('IDX_activity_daily_screen', ['screen', 'type', 'day'])
export class ActivityDaily {
    @PrimaryGeneratedColumn('increment', { type: 'bigint' })
    id: string;

    @Column({ type: 'date' })
    day: string;

    @Column('uuid')
    userId: string;

    @Column({ type: 'varchar', length: 20 })
    platformRole: string;

    @Column({ type: 'varchar', length: 10, default: '' })
    storeRole: string;

    @Column({ type: 'varchar', length: 10 })
    type: string;

    @Column({ type: 'varchar', length: 60 })
    screen: string;

    /** Elemento (clics) o acción (acciones); vacío en las vistas. */
    @Column({ type: 'varchar', length: 120, default: '' })
    element: string;

    @Column({ type: 'int' })
    n: number;

    /** Posición media del elemento en la pantalla, en milésimas. */
    @Column({ type: 'smallint', nullable: true }) ex: number | null;
    @Column({ type: 'smallint', nullable: true }) ey: number | null;
    @Column({ type: 'smallint', nullable: true }) ew: number | null;
    @Column({ type: 'smallint', nullable: true }) eh: number | null;
}

/** Resumen por día y hora (Lima): cuánta actividad y cuánto tiempo activo. Se conserva 2 años. */
@Entity('activity_hourly')
@Unique('UQ_activity_hourly', ['day', 'userId', 'platformRole', 'storeRole', 'hour'])
@Index('IDX_activity_hourly_day', ['day'])
export class ActivityHourly {
    @PrimaryGeneratedColumn('increment', { type: 'bigint' })
    id: string;

    @Column({ type: 'date' })
    day: string;

    @Column('uuid')
    userId: string;

    @Column({ type: 'varchar', length: 20 })
    platformRole: string;

    @Column({ type: 'varchar', length: 10, default: '' })
    storeRole: string;

    @Column({ type: 'smallint' })
    hour: number;

    @Column({ type: 'int' })
    events: number;

    @Column({ type: 'int' })
    seconds: number;
}

/** Quién aceptó el aviso de privacidad, qué versión y cuándo. Sin aceptación vigente no se registra nada de esa persona. */
@Entity('privacy_consents')
@Unique('UQ_privacy_consent', ['userId', 'version'])
export class PrivacyConsent {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    userId: string;

    @Column({ type: 'varchar', length: 20 })
    version: string;

    @Column({ type: 'varchar', length: 12 })
    via: string;

    @CreateDateColumn({ type: 'timestamptz' })
    acceptedAt: Date;
}
