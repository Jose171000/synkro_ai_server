import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { MarketplaceValueList } from '../../categories/entities/marketplace-value-list.entity';
import { buscarMarcas, MARCA_GENERICA, revisarMarca } from './ripley-marcas';

/** Código con el que se guarda la lista de marcas aprobadas de Ripley en `marketplace_value_lists`. */
export const LISTA_DE_MARCAS = 'marca';
const VIGENCIA_CACHE_MS = 10 * 60 * 1000;

/**
 * La lista de marcas aprobadas de Ripley (27.116 + «GENÉRICO»). La API de Ripley no la entrega: solo viene en la plantilla de
 * carga del portal, por eso se guarda desde un archivo (`data/ripley-marcas.json`) y se busca desde la base de datos.
 */
@Injectable()
export class RipleyMarcasService {
    private readonly logger = new Logger('RipleyMarcas');
    private cache: { marcas: string[]; hasta: number } | null = null;

    constructor(@InjectRepository(MarketplaceValueList) private readonly listas: Repository<MarketplaceValueList>) { }

    /** Todas las marcas (con una copia en memoria unos minutos: son miles y se consultan al teclear). */
    async todas(): Promise<string[]> {
        if (this.cache && this.cache.hasta > Date.now()) return this.cache.marcas;
        const fila = await this.listas.findOne({ where: { marketplace: 'ripley', code: LISTA_DE_MARCAS } });
        const marcas = Array.isArray(fila?.values) ? fila!.values : [];
        this.cache = { marcas, hasta: Date.now() + VIGENCIA_CACHE_MS };
        return marcas;
    }

    async buscar(texto: string, max = 30): Promise<string[]> {
        return buscarMarcas(await this.todas(), texto, max);
    }

    async revisar(texto: string) {
        return revisarMarca(await this.todas(), texto);
    }

    /** Carga (o actualiza) la lista desde `data/ripley-marcas.json`. Se puede repetir: reemplaza la lista completa. */
    async cargarDesdeArchivo(): Promise<{ marcas: number; generica: boolean }> {
        const rutas = [join(process.cwd(), 'data', 'ripley-marcas.json'), join(__dirname, '..', '..', '..', 'data', 'ripley-marcas.json')];
        const archivo = rutas.find((r) => existsSync(r));
        if (!archivo) throw new BadRequestException('No se encontró el archivo data/ripley-marcas.json con las marcas de Ripley.');
        let datos: unknown;
        try { datos = JSON.parse(readFileSync(archivo, 'utf8')); } catch { throw new BadRequestException('El archivo de marcas de Ripley no es un JSON válido.'); }
        if (!Array.isArray(datos)) throw new BadRequestException('El archivo de marcas de Ripley debe ser una lista.');
        const marcas = [...new Set(datos.map((m) => String(m ?? '').trim()).filter(Boolean))];
        if (!marcas.includes(MARCA_GENERICA)) marcas.unshift(MARCA_GENERICA);

        const previa = await this.listas.findOne({ where: { marketplace: 'ripley', code: LISTA_DE_MARCAS }, select: { id: true } });
        await this.listas.save({ ...(previa ? { id: previa.id } : {}), marketplace: 'ripley', code: LISTA_DE_MARCAS, label: 'Marcas aprobadas de Ripley', values: marcas } as any);
        this.cache = null;
        this.logger.log(`Marcas de Ripley guardadas: ${marcas.length}.`);
        return { marcas: marcas.length, generica: marcas.includes(MARCA_GENERICA) };
    }
}
