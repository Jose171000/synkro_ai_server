import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Guarda la moneda de cada cuenta conectada.
 *
 * Antes el código escribía `currency: 'PEN'` a mano al importar los pedidos de
 * Falabella. Falabella usa la misma API para Perú, Chile y Colombia, así que un
 * cliente colombiano habría tenido sus ventas guardadas en soles y la
 * facturación habría salido mal sin dar ningún error.
 *
 * La columna se añade opcional y vacía a propósito: una conexión sin moneda
 * usa la de por defecto de la instalación (`DEFAULT_CURRENCY`, que vale 'PEN'),
 * que es exactamente lo que hacía el código antes. Por eso esta migración no
 * cambia ni un solo dato existente y no hay nada que rellenar.
 */
export class MonedaPorCuenta1788538261723 implements MigrationInterface {
    name = 'MonedaPorCuenta1788538261723'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "marketplace_connections" ADD "currency" character varying(5)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "marketplace_connections" DROP COLUMN "currency"`,
        );
    }

}
