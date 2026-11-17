import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { UploadService } from './upload.service';

/** Carpeta de Cloudinary donde Synkro sube las fotos de productos. Lo que no esté ahí nunca se borra. */
const CARPETA = 'products';

/**
 * El identificador de Cloudinary de una foto NUESTRA (de nuestra cuenta y de la carpeta de productos), o null si no lo es.
 * Una foto importada de otro sitio (Falabella, Mercado Libre…) o de otra cuenta devuelve null: no se toca.
 */
export function publicIdDeCloudinary(url: string, nombreDeLaNube: string | undefined): string | null {
    if (!url || !nombreDeLaNube) return null;
    const m = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/(?:v\d+\/)?([^?#]+)$/i.exec(url.trim());
    if (!m || m[1] !== nombreDeLaNube) return null;
    const sinExtension = m[2].replace(/\.[a-z0-9]{2,5}$/i, '');
    return sinExtension.startsWith(`${CARPETA}/`) ? sinExtension : null;
}

export type FiltroDeProductos = { columna: 'id' | 'storeId' | 'ownerId'; valor: string };

/**
 * Las fotos que se pueden borrar al eliminar productos: solo las de productos que YA NO están en ningún canal (Falabella y Ripley cargan
 * las fotos desde nuestras URL: borrarlas dejaría la publicación sin imagen). Se llama ANTES de eliminar, mientras se ven las publicaciones.
 */
export async function fotosBorrables(manager: EntityManager, filtros: FiltroDeProductos[]): Promise<string[]> {
    if (!filtros.length) return [];
    const columnas: Record<FiltroDeProductos['columna'], string> = { id: 'p.id', storeId: 'p."storeId"', ownerId: 'p."ownerId"' };
    const condicion = filtros.map((f, i) => `${columnas[f.columna]} = $${i + 1}`).join(' OR ');
    const filas: { url: string }[] = await manager.query(
        `SELECT DISTINCT i.url AS url FROM product_images i JOIN products p ON p.id = i."productId"
         WHERE (${condicion})
           AND NOT EXISTS (SELECT 1 FROM listing_links l WHERE l."productId" = p.id AND l."syncStatus" <> 'removed')`,
        filtros.map((f) => f.valor),
    );
    return filas.map((f) => f.url).filter(Boolean);
}

/**
 * Borra de Cloudinary las fotos que quedaron sin dueño al eliminar productos. Nunca interrumpe lo que se esté haciendo:
 * si algo falla, la foto simplemente se queda (se registra el aviso).
 */
@Injectable()
export class LimpiezaDeFotos {
    private readonly logger = new Logger(LimpiezaDeFotos.name);

    constructor(
        private readonly upload: UploadService,
        private readonly dataSource: DataSource,
        @Optional() private readonly config?: ConfigService,
    ) { }

    /** Borra las fotos de la lista que ningún otro producto sigue usando. Devuelve cuántas se borraron y cuántas se conservaron. */
    async borrar(urls: string[]): Promise<{ borradas: number; conservadas: number }> {
        const nube = this.config?.get<string>('CLOUDINARY_CLOUD_NAME') ?? process.env.CLOUDINARY_CLOUD_NAME;
        let borradas = 0;
        let conservadas = 0;
        for (const url of [...new Set((urls ?? []).filter(Boolean))]) {
            try {
                const publicId = publicIdDeCloudinary(url, nube);
                if (!publicId) { conservadas++; continue; }
                // Las variantes de un grupo y los productos copiados pueden compartir la misma foto: si alguien más la usa, se queda.
                const [{ n }] = await this.dataSource.query('SELECT COUNT(*)::int AS n FROM product_images WHERE url = $1', [url]);
                if (Number(n) > 0) { conservadas++; continue; }
                await this.upload.deleteImage(publicId);
                borradas++;
            } catch (error: any) {
                conservadas++;
                this.logger.warn(`No se pudo borrar una foto de Cloudinary: ${error?.message}`);
            }
        }
        if (borradas) this.logger.log(`Fotos borradas de Cloudinary: ${borradas} (se conservaron ${conservadas}).`);
        return { borradas, conservadas };
    }
}
