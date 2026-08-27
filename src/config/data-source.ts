import 'dotenv/config';
import { DataSource } from 'typeorm';

/**
 * Conexión que usan las HERRAMIENTAS de migración (no la aplicación).
 *
 * La app se configura en app.module.ts; esto es solo para los comandos
 * `npm run migration:*`. Están separados a propósito: así se puede apuntar a
 * una base distinta —por ejemplo la de producción, para comparar— sin tocar
 * cómo arranca el servidor.
 *
 * Con PROD_DATABASE_URL definida, los comandos apuntan a esa base. Sin ella,
 * a la local del .env. Nunca se escribe esa URL en el repositorio.
 */

const productionUrl = process.env.PROD_DATABASE_URL;

export default new DataSource(
    productionUrl
        ? {
            type: 'postgres',
            url: productionUrl,
            // Railway expone Postgres con un certificado propio.
            ssl: { rejectUnauthorized: false },
            entities: ['src/**/*.entity.ts'],
            migrations: ['src/migrations/*.ts'],
            // Ninguna herramienta modifica el esquema por su cuenta.
            synchronize: false,
        }
        : {
            type: 'postgres',
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT || 5432),
            username: process.env.DB_USERNAME,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            entities: ['src/**/*.entity.ts'],
            migrations: ['src/migrations/*.ts'],
            synchronize: false,
        },
);
