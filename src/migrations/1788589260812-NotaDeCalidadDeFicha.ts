import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Guarda la nota de calidad que el canal pone a cada publicación.
 *
 * Falabella la devuelve en `ContentScore`, de 0 a 100, y es exactamente la
 * medida de optimización que hasta ahora se calculaba a mano en una hoja de
 * cálculo. Al venir del propio canal deja de ser una estimación nuestra.
 *
 * La columna es opcional y nace vacía: no todos los canales publican una nota,
 * y las publicaciones que ya existen se rellenan la primera vez que se
 * importa el catálogo. Nada de lo guardado cambia con esta migración.
 */
export class NotaDeCalidadDeFicha1788589260812 implements MigrationInterface {
    name = 'NotaDeCalidadDeFicha1788589260812'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "listing_links" ADD "qualityScore" integer`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "listing_links" DROP COLUMN "qualityScore"`,
        );
    }

}
