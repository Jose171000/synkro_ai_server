import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { backfillMarketplaceCredentials } from '../common/crypto/credentials-backfill';

/**
 * Al arrancar el servidor, cifra cualquier credencial de marketplace que
 * siguiera guardada en texto plano.
 *
 * Se hace automáticamente para que no dependa de que alguien se acuerde de
 * ejecutar un comando: el objetivo del cifrado se pierde si las credenciales
 * viejas se quedan legibles en la base de datos. Es idempotente, así que
 * reiniciar el servidor no tiene ningún efecto adicional.
 *
 * Si algo falla, se registra el error pero el servidor sigue levantando: las
 * conexiones en texto plano se siguen leyendo con normalidad, así que un fallo
 * aquí nunca deja a los clientes sin publicar.
 */
@Injectable()
export class CredentialsEncryptionService implements OnModuleInit {
    private readonly logger = new Logger('CredentialsEncryption');

    constructor(@InjectDataSource() private readonly dataSource: DataSource) { }

    async onModuleInit(): Promise<void> {
        try {
            const result = await backfillMarketplaceCredentials(
                (sql, params) => this.dataSource.query(sql, params),
            );

            if (result.migrated > 0) {
                this.logger.warn(
                    `Se cifraron ${result.migrated} credenciales que estaban en texto plano ` +
                    `(${result.alreadyEncrypted} ya lo estaban).`,
                );
                result.details.forEach(line => this.logger.warn(`  ${line}`));
            } else if (result.total > 0) {
                this.logger.log(`Credenciales de marketplaces: ${result.total} conexiones, todas cifradas.`);
            }
        } catch (error: any) {
            this.logger.error(
                `No se pudo revisar el cifrado de credenciales: ${error?.message}. ` +
                `Ejecuta "npm run credentials:check" para diagnosticarlo.`,
            );
        }
    }
}
