import { CanActivate, Controller, ExecutionContext, Get, HttpCode, Injectable, Post, Req, Res, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiExcludeController } from '@nestjs/swagger';
import { randomBytes } from 'crypto';
import { claveDeLaCabecera } from './mcp.service';
import { paginaDeSubida } from './subida-fotos.pagina';
import { MAX_FOTOS_POR_SUBIDA, SubidaDeFotosService } from './subida-fotos.service';

/** Valida el enlace ANTES de leer ningún archivo: sin enlace vigente no se recibe nada. */
@Injectable()
export class EnlaceDeSubidaGuard implements CanActivate {
    constructor(private readonly subidas: SubidaDeFotosService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        req.subida = await this.subidas.sesion(claveDeLaCabecera(req.headers?.authorization));
        return true;
    }
}

/** La página del enlace de subida y su envío. No usa el login de la app: se entra con el secreto del enlace. */
@ApiExcludeController()
@Controller('mcp/subir-fotos')
export class SubidaDeFotosController {
    constructor(private readonly subidas: SubidaDeFotosService) { }

    @Get()
    pagina(@Res() res) {
        const nonce = randomBytes(16).toString('base64');
        res.status(200)
            .set({
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer',
                'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
            })
            .send(paginaDeSubida(nonce));
    }

    @Get('estado')
    @UseGuards(EnlaceDeSubidaGuard)
    estado(@Req() req) {
        return this.subidas.datos(req.subida);
    }

    @Post()
    @HttpCode(200)
    @UseGuards(EnlaceDeSubidaGuard)
    @UseInterceptors(FilesInterceptor('images', MAX_FOTOS_POR_SUBIDA, { limits: { fileSize: 10 * 1024 * 1024, files: MAX_FOTOS_POR_SUBIDA, fields: 0 } }))
    subir(@UploadedFiles() archivos: Express.Multer.File[], @Req() req) {
        return this.subidas.subir(req.subida, archivos);
    }
}
