import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { lookup } from 'dns';
import { Agent } from 'https';
import { BlockList, isIP } from 'net';

/**
 * Descarga de las fotos que un asistente pasa como enlace. El enlace lo puede haber escrito cualquiera (un asistente al que
 * le inyectaron instrucciones), así que solo se permite https hacia direcciones públicas, sin redirecciones: nunca la red
 * interna del servidor.
 */
export const MAX_BYTES_DE_IMAGEN = 10 * 1024 * 1024;

const privadas = new BlockList();
const REDES_PRIVADAS: [string, number][] = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
for (const [red, bits] of REDES_PRIVADAS) privadas.addSubnet(red, bits, 'ipv4');

/** ¿Es una dirección de internet? En IPv6 solo el rango global (2000::/3), sin las formas que envuelven una IPv4. */
export function esDireccionPublica(ip: string): boolean {
    const tipo = isIP(ip);
    if (tipo === 4) return !privadas.check(ip, 'ipv4');
    if (tipo === 6) return /^[23][0-9a-f]{3}:/i.test(ip) && !/^2002:/i.test(ip) && !/^2001:0{0,4}:/i.test(ip);
    return false;
}

/** La resolución de nombres que usa la conexión: se comprueba la MISMA dirección a la que se conecta. */
const buscarSoloPublicas = (host: string, opciones: any, listo: any) => {
    lookup(host, { all: true }, (error, direcciones) => {
        if (error) return listo(error);
        if (!direcciones.length || direcciones.some((d) => !esDireccionPublica(d.address))) return listo(new Error('dirección no permitida'));
        if (opciones?.all) return listo(null, direcciones);
        listo(null, direcciones[0].address, direcciones[0].family);
    });
};

export function enlaceDeImagen(texto: string): URL {
    let url: URL;
    try { url = new URL(texto); }
    catch { throw new BadRequestException(`«${texto.slice(0, 80)}» no es un enlace.`); }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || local || (isIP(host) && !esDireccionPublica(host))) {
        throw new BadRequestException(`Las fotos deben ser enlaces https públicos: ${texto.slice(0, 80)}`);
    }
    return url;
}

/** Descarga las fotos y las devuelve como archivos, para subirlas por el mismo camino que las de la app (que valida JPG y tamaño). */
export async function descargarImagenes(enlaces: string[]): Promise<Express.Multer.File[]> {
    const urls = enlaces.map(enlaceDeImagen);
    const agente = new Agent({ lookup: buscarSoloPublicas as any });
    const archivos: Express.Multer.File[] = [];
    // De una en una: son enlaces ajenos y así la memoria usada queda acotada.
    for (const [i, url] of urls.entries()) {
        let buffer: Buffer;
        let mimetype: string;
        try {
            const r = await axios.get(url.href, { responseType: 'arraybuffer', timeout: 10_000, maxRedirects: 0, proxy: false, httpsAgent: agente, maxContentLength: MAX_BYTES_DE_IMAGEN });
            buffer = Buffer.from(r.data);
            mimetype = String(r.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        } catch {
            // Sin detalles del error de red: no se le cuenta a quien pide qué hay detrás de una dirección.
            throw new BadRequestException(`No se pudo descargar la foto ${i + 1} (debe ser un enlace directo, sin redirecciones, de hasta 10 MB): ${url.href.slice(0, 120)}`);
        }
        if (!['image/jpeg', 'image/jpg'].includes(mimetype)) throw new BadRequestException(`La foto ${i + 1} no es una imagen JPG: ${url.href.slice(0, 120)}`);
        archivos.push({ buffer, mimetype, originalname: `mcp-${i + 1}.jpg`, size: buffer.length, fieldname: 'images' } as Express.Multer.File);
    }
    return archivos;
}
