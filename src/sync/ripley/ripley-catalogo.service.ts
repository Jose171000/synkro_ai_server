import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MarketplaceCategory } from '../../categories/entities/marketplace-category.entity';
import { MarketplaceValueList } from '../../categories/entities/marketplace-value-list.entity';
import { buscarMarcas, normalizarMarca } from './ripley-marcas';
import { camposDeCategoria, ejesDeVariante, validarAtributosEscritos } from './ripley-catalogo';

const VIGENCIA_CACHE_MS = 10 * 60 * 1000;

/**
 * Lo que la pantalla de Ripley consulta del catálogo ya importado: buscar categorías, los campos de una categoría y los valores
 * de una lista larga. Todo sale de nuestra base de datos (no se llama a Ripley).
 */
@Injectable()
export class RipleyCatalogoService {
    private indice: { filas: { id: string; name: string; norm: string }[]; hasta: number } | null = null;

    constructor(
        @InjectRepository(MarketplaceCategory) private readonly categorias: Repository<MarketplaceCategory>,
        @InjectRepository(MarketplaceValueList) private readonly listas: Repository<MarketplaceValueList>,
    ) { }

    /** Nombre y código de cada categoría (sin sus vectores, que pesan mucho), con copia en memoria unos minutos. */
    private async filas() {
        if (this.indice && this.indice.hasta > Date.now()) return this.indice.filas;
        const todas = await this.categorias.find({ where: { marketplace: 'ripley' }, select: { categoryId: true, name: true } });
        const filas = todas.map((c) => ({ id: c.categoryId, name: c.name, norm: normalizarMarca(c.name) }));
        this.indice = { filas, hasta: Date.now() + VIGENCIA_CACHE_MS };
        return filas;
    }

    /** Categorías donde se puede publicar que contienen TODAS las palabras escritas; primero las que terminan en esa palabra. */
    async buscarCategorias(texto: string, max = 20): Promise<{ id: string; name: string; path: string }[]> {
        const palabras = normalizarMarca(texto).split(' ').filter(Boolean);
        if (!palabras.length) return [];
        const hallazgos = (await this.filas()).filter((f) => palabras.every((p) => f.norm.includes(p)));
        const ultimo = (f: { norm: string }) => f.norm.split(' ').slice(-palabras.length).join(' ');
        hallazgos.sort((a, b) => Number(ultimo(b).startsWith(palabras[0])) - Number(ultimo(a).startsWith(palabras[0])) || a.name.length - b.name.length);
        // `name` es la ruta completa («MALETERÍA › LONCHERAS»); el nombre corto es su último tramo.
        return hallazgos.slice(0, max).map((f) => ({ id: f.id, name: f.name.split(' › ').pop() ?? f.name, path: f.name }));
    }

    private async categoria(id: string) {
        const c = await this.categorias.findOne({ where: { marketplace: 'ripley', categoryId: id }, select: { categoryId: true, name: true, requiredAttributes: true } });
        if (!c) throw new NotFoundException('Esa categoría de Ripley no está en el catálogo importado.');
        return c;
    }

    async listasDe(codigos: string[]): Promise<Map<string, string[]>> {
        const unicos = [...new Set(codigos.filter(Boolean))];
        if (!unicos.length) return new Map();
        const filas = await this.listas.find({ where: { marketplace: 'ripley', code: In(unicos) } });
        return new Map(filas.map((f) => [f.code, Array.isArray(f.values) ? f.values : []]));
    }

    /** Los campos que pide una categoría, listos para dibujar, y si admite agrupar variantes. */
    async campos(categoryId: string) {
        const c = await this.categoria(categoryId);
        const atributos = c.requiredAttributes ?? [];
        const listas = await this.listasDe(atributos.map((a) => a.listCode ?? ''));
        const ejes = ejesDeVariante(atributos);
        return { id: c.categoryId, path: c.name, campos: camposDeCategoria(atributos, listas), ejesDeVariante: ejes, admiteVariantes: ejes.length > 0 };
    }

    /** Todos los valores de una lista cerrada (para comprobar si un color o una talla existe en Ripley). */
    async listaCompleta(code: string): Promise<string[]> {
        return (await this.listasDe([code])).get(code) ?? [];
    }

    /** Valores de una lista cerrada que coinciden con el texto (para las listas largas, como el tipo de producto). */
    async valoresDeLista(code: string, texto: string, max = 30): Promise<string[]> {
        const fila = await this.listas.findOne({ where: { marketplace: 'ripley', code } });
        return buscarMarcas(Array.isArray(fila?.values) ? fila!.values : [], texto, max);
    }

    /** Valida lo que escribió la persona para una categoría (llevándolo a la escritura exacta de Ripley). */
    async validar(categoryId: string, escritos: Record<string, any>) {
        const c = await this.categoria(categoryId);
        const atributos = c.requiredAttributes ?? [];
        const listas = await this.listasDe(atributos.map((a) => a.listCode ?? ''));
        return { ruta: c.name, ...validarAtributosEscritos(escritos, atributos, listas) };
    }

    /** ¿Existe la categoría? Devuelve su ruta. */
    async rutaDe(categoryId: string): Promise<string> {
        return (await this.categoria(categoryId)).name;
    }
}
