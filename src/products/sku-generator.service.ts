import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Optional } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { ProductGroup } from './entities/product-group.entity';
import { StoresService } from '../stores/stores.service';
import { armarSku, iniciales, mayorNumeroConPrefijo, patronDominante, PatronDeSku } from './sku-generator';

/** Cuántos de los últimos productos publicados se miran para reconocer el formato de SKU de una tienda. */
export const BLOQUE_DE_PUBLICADOS = 20;
const ANCHO_POR_DEFECTO = 4;

export interface AmbitoDeSku {
    userId: string;
    storeId?: string | null;
}

/**
 * Genera SKU nuevos siguiendo la convención de cada tienda: si ya tiene productos publicados, continúa el formato del
 * último bloque (prefijo y relleno de ceros, con el número siguiente al mayor usado); si no tiene, usa el formato propio
 * «INICIALES-0001». Nunca devuelve un SKU que ya exista en la tienda ni uno de los `ocupados` que se le indiquen.
 */
@Injectable()
export class SkuGeneratorService {
    constructor(
        @InjectRepository(Product) private readonly productRepository: Repository<Product>,
        private readonly stores: StoresService,
        @Optional() @InjectRepository(ProductGroup) private readonly grupos?: Repository<ProductGroup>,
    ) { }

    /** Los próximos `cantidad` SKU libres de la tienda, consecutivos. */
    async siguientes(ambito: AmbitoDeSku, cantidad = 1, ocupados: Set<string> = new Set()): Promise<string[]> {
        const patron = await this.patronDeLaTienda(ambito);
        const codigosDeGrupo = await this.codigosDeGrupo(ambito);
        const existentes = [...(await this.skusConPrefijo(ambito, patron.prefijo)), ...codigosDeGrupo.filter((c) => c.toLowerCase().startsWith(patron.prefijo.toLowerCase()))];
        let numero = mayorNumeroConPrefijo(existentes, patron.prefijo) + 1;
        const deGrupos = new Set(codigosDeGrupo.map((c) => c.trim().toLowerCase()));

        const salida: string[] = [];
        while (salida.length < cantidad) {
            const sku = armarSku(patron.prefijo, numero++, patron.ancho);
            // Un código de grupo de variantes también es un identificador ocupado: un producto nuevo con él se mezclaría con esa familia en los canales.
            if (ocupados.has(sku.toLowerCase()) || deGrupos.has(sku.toLowerCase())) continue;
            salida.push(sku);
        }
        return salida;
    }

    /** Los códigos de los grupos de variantes de la tienda. */
    private async codigosDeGrupo(ambito: AmbitoDeSku): Promise<string[]> {
        if (!this.grupos) return [];
        const qb = this.grupos.createQueryBuilder('g').select('g."parentSku"', 'sku');
        const filas: { sku: string }[] = await (ambito.storeId
            ? qb.where('g."storeId" = :storeId', { storeId: ambito.storeId })
            : qb.where('g."ownerId" = :userId', { userId: ambito.userId }).andWhere('g."storeId" IS NULL'))
            .getRawMany();
        return filas.map((f) => String(f.sku ?? '')).filter(Boolean);
    }

    /** El formato que usa la tienda: el dominante entre sus últimos productos publicados, o el propio por defecto. */
    async patronDeLaTienda(ambito: AmbitoDeSku): Promise<PatronDeSku> {
        const recientes = await this.ultimosPublicados(ambito);
        return patronDominante(recientes) ?? { prefijo: `${await this.prefijoPorDefecto(ambito)}-`, ancho: ANCHO_POR_DEFECTO };
    }

    private async prefijoPorDefecto(ambito: AmbitoDeSku): Promise<string> {
        if (!ambito.storeId) return 'SKU';
        const { stores } = await this.stores.listMine(ambito.userId);
        return iniciales(stores.find((t) => t.id === ambito.storeId)?.name ?? '');
    }

    /** SKU de los últimos productos publicados de la tienda (el más reciente primero); sin publicados, los últimos creados. */
    private async ultimosPublicados(ambito: AmbitoDeSku): Promise<string[]> {
        const enLaTienda = (qb: any) => (ambito.storeId
            ? qb.where('p."storeId" = :storeId', { storeId: ambito.storeId })
            : qb.where('p."ownerId" = :userId', { userId: ambito.userId }).andWhere('p."storeId" IS NULL'));

        const publicados: { sku: string }[] = await enLaTienda(
            this.productRepository.createQueryBuilder('p')
                .select('p.sku', 'sku')
                .addSelect('MAX(l."createdAt")', 'ultimo')
                .innerJoin('listing_links', 'l', 'l."productId" = p.id'),
        )
            .andWhere("l.\"syncStatus\" = 'published'")
            .groupBy('p.id')
            .orderBy('ultimo', 'DESC')
            .limit(BLOQUE_DE_PUBLICADOS)
            .getRawMany();
        if (publicados.length) return publicados.map((r) => r.sku);

        const creados: { sku: string }[] = await enLaTienda(this.productRepository.createQueryBuilder('p').select('p.sku', 'sku'))
            .orderBy('p."createdAt"', 'DESC')
            .limit(BLOQUE_DE_PUBLICADOS)
            .getRawMany();
        return creados.map((r) => r.sku);
    }

    /** Todos los SKU de la tienda que empiezan por ese prefijo (para saber cuál es el mayor número usado). */
    private async skusConPrefijo(ambito: AmbitoDeSku, prefijo: string): Promise<string[]> {
        const comodin = `${prefijo.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const qb = this.productRepository.createQueryBuilder('p').select('p.sku', 'sku');
        const filas: { sku: string }[] = await (ambito.storeId
            ? qb.where('p."storeId" = :storeId', { storeId: ambito.storeId })
            : qb.where('p."ownerId" = :userId', { userId: ambito.userId }).andWhere('p."storeId" IS NULL'))
            .andWhere('LOWER(p.sku) LIKE :comodin', { comodin })
            .getRawMany();
        return filas.map((f) => f.sku);
    }
}
