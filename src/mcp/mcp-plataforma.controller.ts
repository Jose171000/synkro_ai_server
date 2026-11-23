import { Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { McpPlataformaService, mcpPlataformaActivo } from './mcp-plataforma.service';

const errorRpc = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Entrada del MCP de PLATAFORMA (`POST /api/v1/mcp/admin`): lo que un superadmin consulta de toda la agencia. Se entra con una
 * clave de plataforma (`Authorization: Bearer sya_...`); una clave de tienda no sirve aquí ni esta sirve en `/mcp`.
 * Se apaga con `MCP_PLATAFORMA_ACTIVO=false`. Ver docs/mcp.md.
 */
@ApiExcludeController()
@Controller('mcp/admin')
export class McpPlataformaController {
    constructor(private readonly mcp: McpPlataformaService) { }

    @Post()
    @HttpCode(200)
    async recibir(@Req() req, @Res() res) {
        // Apagado: ni siquiera se dice que existe.
        if (!mcpPlataformaActivo()) throw new NotFoundException();

        let acceso;
        try {
            acceso = await this.mcp.autenticar(req.headers?.authorization);
        } catch (error: any) {
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

    @Get()
    noGet(@Res() res) {
        res.status(405).set('Allow', 'POST').json(errorRpc(-32000, 'Método no permitido: usa POST.'));
    }

    @Delete()
    noDelete(@Res() res) {
        res.status(405).set('Allow', 'POST').json(errorRpc(-32000, 'Método no permitido: usa POST.'));
    }
}
