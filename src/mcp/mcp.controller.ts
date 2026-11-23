import { Controller, Delete, ForbiddenException, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { McpService } from './mcp.service';

const errorRpc = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Entrada del MCP (`POST /api/v1/mcp`, transporte Streamable HTTP sin sesión). No usa el login de la app: se entra con una
 * clave de la tienda (`Authorization: Bearer syk_...`, ver docs/mcp.md). La respuesta es del protocolo, por eso el
 * `TransformInterceptor` la deja pasar.
 */
@ApiExcludeController()
@Controller('mcp')
export class McpController {
    constructor(private readonly mcp: McpService) { }

    @Post()
    @HttpCode(200)
    async recibir(@Req() req, @Res() res) {
        let acceso;
        try {
            acceso = await this.mcp.autenticar(req.headers?.authorization);
        } catch (error: any) {
            // 403 si la clave es válida pero ya no tiene nada que ofrecer; 401 para todo lo demás, sin dar pistas.
            if (error instanceof ForbiddenException) {
                res.status(403).json(errorRpc(-32001, error.message));
                return;
            }
            res.status(401).set('WWW-Authenticate', 'Bearer').json(errorRpc(-32001, 'Clave inválida, caducada o revocada.'));
            return;
        }
        try {
            await this.mcp.atender(acceso, req, res);
        } catch {
            if (!res.headersSent) res.status(500).json(errorRpc(-32603, 'Error interno.'));
        }
    }

    // Sin sesión no hay flujo de eventos que abrir ni sesión que cerrar.
    @Get()
    noGet(@Res() res) {
        res.status(405).set('Allow', 'POST').json(errorRpc(-32000, 'Método no permitido: usa POST.'));
    }

    @Delete()
    noDelete(@Res() res) {
        res.status(405).set('Allow', 'POST').json(errorRpc(-32000, 'Método no permitido: usa POST.'));
    }
}
