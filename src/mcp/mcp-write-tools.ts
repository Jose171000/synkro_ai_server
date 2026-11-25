import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { UploadService } from '../upload/upload.service';
import type { AccesoMcp } from './api-keys.service';
import { descargarImagenes } from './imagenes-seguras';
import type { HerramientaMcp, ServiciosMcp } from './mcp-tools';

/**
 * Herramientas que CAMBIAN datos. Solo en el MCP de tienda (el de plataforma es de lectura), solo con claves que lleven el
 * permiso, y ninguna envía nada a un canal de venta: crean productos y editan los que todavía no están vinculados a ninguno.
 */
export interface HerramientaDeEscritura extends HerramientaMcp {
    escribe: true;
    unaSolaVez?: boolean;
    usaIa?: boolean;
    /** Lo que queda en el registro de cambios. */
    resumen(args: any): Record<string, unknown>;
}

export const MAX_FOTOS_POR_PRODUCTO = 8;
export const MAX_FOTOS_POR_LLAMADA = 30;
export const MAX_VARIANTES_POR_LLAMADA = 50;

const texto = (max: number) => z.string().trim().min(1).max(max);
const precio = z.number().min(0).max(10_000_000);
const stock = z.number().int().min(0).max(1_000_000);
const sku = z.string().trim().min(1).max(60);
const fotos = z.array(z.string().max(2000)).max(MAX_FOTOS_POR_PRODUCTO)
    .describe('Enlaces https directos a fotos JPG (máx. 10 MB y 2000×2000 px). No sirven archivos del computador ni fotos pegadas en el chat.');
const canales = z.array(z.enum(['mercadolibre', 'falabella', 'ripley', 'woocommerce', 'shopify', 'amazon'])).max(6).optional()
    .describe('Canales a los que se piensa publicar (solo orienta el contenido; NO publica nada).');
const ejes = z.array(z.object({ name: texto(40), values: z.array(texto(60)).min(1).max(50) })).min(1).max(3)
    .describe('Los ejes de variación, p. ej. [{"name":"Color","values":["Rojo","Azul"]}].');
const variantes = z.array(z.object({
    values: z.record(z.string(), z.string()).describe('El valor de cada eje, p. ej. {"Color":"Rojo"}.'),
    sku: sku.optional(),
    price: precio.optional(),
    stock: stock.optional(),
    images: fotos.optional(),
})).min(1).max(MAX_VARIANTES_POR_LLAMADA);

const scope = (a: AccesoMcp) => ({ userId: a.userId, storeId: a.storeId });

/** Sube a la cuenta de fotos de la app las de los enlaces, y devuelve sus direcciones definitivas. */
async function subirFotos(upload: UploadService, enlaces: string[]): Promise<string[]> {
    if (!enlaces.length) return [];
    if (enlaces.length > MAX_FOTOS_POR_LLAMADA) throw new BadRequestException(`Máximo ${MAX_FOTOS_POR_LLAMADA} fotos distintas por llamada.`);
    const archivos = await descargarImagenes(enlaces);
    return (await upload.uploadImages(archivos, 'products')).map((r) => r.secureUrl);
}

/** Las fotos que comparten varias variantes se suben una sola vez. */
async function subirFotosDeVariantes<T extends { images?: string[] }>(upload: UploadService, lista: T[]) {
    const unicas = [...new Set(lista.flatMap((v) => v.images ?? []))];
    const subidas = await subirFotos(upload, unicas);
    const nueva = new Map(unicas.map((u, i) => [u, subidas[i]]));
    return lista.map((v) => ({ ...v, images: (v.images ?? []).map((u) => nueva.get(u)!) }));
}

const vistaDeGrupo = (g: any) => ({
    id: g.id,
    name: g.name,
    parentSku: g.parentSku,
    axes: g.axes,
    variants: (g.variants ?? []).map((v: any) => ({ id: v.id, sku: v.sku, values: v.variantValues, price: v.price, stock: v.stock, fotos: v.images?.length ?? 0 })),
});

/**
 * Cambiar un producto que ya está en un canal llega allí, o lo deja distinto de lo que ven los compradores: desde el MCP no
 * se hace. Vale para el producto y para cualquiera de las variantes de su grupo.
 */
async function exigirSinPublicar({ products }: ServiciosMcp, a: AccesoMcp, id: string) {
    const estado = await products.estadoParaEditarSinPublicar(id, a.userId, a.storeId);
    if (estado.vinculado) {
        throw new BadRequestException('Este producto (o una de sus variantes) ya está vinculado a un canal de venta. Desde el asistente solo se editan productos sin publicar: hazlo en la app.');
    }
    return estado;
}

export const HERRAMIENTAS_DE_ESCRITURA: HerramientaDeEscritura[] = [
    {
        name: 'crear_producto',
        title: 'Crear un producto',
        description: 'Crea un producto simple en la tienda. NO lo publica en ningún canal. Antes de llamar, confirma con la persona el nombre, el precio y el stock: no los inventes.',
        permiso: 'productos.editar',
        escribe: true,
        unaSolaVez: true,
        input: {
            name: texto(255),
            description: texto(5000),
            images: fotos.min(1),
            price: precio.optional(),
            stock: stock.optional(),
            sku: sku.optional().describe('Sin SKU se genera uno con el formato de la tienda.'),
            category: texto(120).optional(),
            subCategory: texto(120).optional(),
            targetMarketplaces: canales,
        },
        resumen: (x) => ({ name: x.name, sku: x.sku }),
        async ejecutar({ products, upload }, a, args) {
            // Antes de subir fotos: un SKU repetido no debe dejar archivos sueltos.
            if (args.sku) await products.assertSkuLibre(args.sku, scope(a));
            const images = await subirFotos(upload, args.images);
            const p: any = await products.create({ ...args, images }, a.userId, a.storeId);
            return { id: p.id, name: p.name, sku: p.sku, price: p.price != null ? Number(p.price) : null, stock: p.stock, fotos: images.length, publicado: false };
        },
    },
    {
        name: 'crear_producto_con_variantes',
        title: 'Crear un producto con variantes',
        description: 'Crea un producto con variantes (color, talla…) en la tienda. NO lo publica en ningún canal. Confirma con la persona los precios y el stock antes de llamar.',
        permiso: 'productos.editar',
        escribe: true,
        unaSolaVez: true,
        input: {
            name: texto(255),
            description: texto(5000),
            parentSku: sku.optional().describe('Código del grupo. Sin él se genera.'),
            category: texto(120).optional(),
            subCategory: texto(120).optional(),
            targetMarketplaces: canales,
            axes: ejes,
            variants: variantes,
        },
        resumen: (x) => ({ name: x.name, parentSku: x.parentSku, variantes: x.variants.length }),
        async ejecutar({ groups, upload }, a, args) {
            if (!args.variants.some((v: any) => v.images?.length)) throw new BadRequestException('Al menos una variante necesita una foto.');
            const conFotos = await subirFotosDeVariantes(upload, args.variants as any[]);
            return vistaDeGrupo(await groups.crear({ ...args, variants: conFotos, generateWithAi: false }, scope(a)));
        },
    },
    {
        name: 'agregar_variantes',
        title: 'Agregar variantes',
        description: 'Agrega variantes a un producto que todavía no está en ningún canal. Si es simple se convierte en grupo: indica los ejes y qué variante es el producto actual (thisVariant).',
        permiso: 'productos.editar',
        escribe: true,
        unaSolaVez: true,
        input: {
            id: z.string().uuid().describe('El id del producto (o de una de sus variantes).'),
            axes: ejes.optional(),
            thisVariant: z.record(z.string(), z.string()).optional(),
            variants: variantes,
        },
        resumen: (x) => ({ id: x.id, variantes: x.variants.length }),
        async ejecutar(servicios, a, args) {
            await exigirSinPublicar(servicios, a, args.id);
            const conFotos = await subirFotosDeVariantes(servicios.upload, args.variants as any[]);
            return vistaDeGrupo(await servicios.groups.agregarVariantes(args.id, { axes: args.axes, thisVariant: args.thisVariant, variants: conFotos }, scope(a)));
        },
    },
    {
        name: 'editar_producto',
        title: 'Editar la ficha de un producto',
        description: 'Cambia nombre, descripción o categoría de un producto que no está en ningún canal. No cambia precio, stock, SKU ni fotos.',
        permiso: 'productos.editar',
        escribe: true,
        input: {
            id: z.string().uuid(),
            name: texto(255).optional(),
            description: texto(5000).optional(),
            category: texto(120).optional(),
            subCategory: texto(120).optional(),
        },
        resumen: (x) => ({ id: x.id, campos: ['name', 'description', 'category', 'subCategory'].filter((k) => x[k] !== undefined) }),
        async ejecutar(servicios, a, args) {
            // Solo estos campos, pase lo que pase en la petición: precio, stock, SKU y fotos no se tocan desde aquí.
            const cambios = Object.fromEntries(['name', 'description', 'category', 'subCategory'].filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
            if (!Object.keys(cambios).length) throw new BadRequestException('No hay nada que cambiar.');
            await exigirSinPublicar(servicios, a, args.id);
            const p: any = await servicios.products.update(args.id, cambios, a.userId, a.storeId);
            return { id: p.id, name: p.name, sku: p.sku, category: p.category ?? null, subCategory: p.subCategory ?? null, guardado: Object.keys(cambios) };
        },
    },
    {
        name: 'generar_contenido_ia',
        title: 'Completar con IA',
        description: 'La IA completa SOLO lo que está vacío (título, descripción, ficha y atributos) de un producto que no está en ningún canal; un grupo de variantes se completa entero. Tarda cerca de un minuto y tiene un tope diario.',
        permiso: 'productos.editar',
        escribe: true,
        usaIa: true,
        input: { id: z.string().uuid().describe('El id del producto (o de una de sus variantes).') },
        resumen: (x) => ({ id: x.id }),
        async ejecutar(servicios, a, args) {
            const { name, groupId } = await exigirSinPublicar(servicios, a, args.id);
            if (groupId) {
                const r = await servicios.groups.regenerarContenido(groupId, { soloVacio: true }, scope(a));
                return { grupo: groupId, variantes: r.variantes, titulo: r.titulo, completado: r.llenado ?? [] };
            }
            const p: any = await servicios.products.generateAIContent(args.id, a.userId, { soloVacio: true }, a.storeId);
            return { name, titulo: p.aiTitle ?? null, completado: p.llenado ?? [] };
        },
    },
];
