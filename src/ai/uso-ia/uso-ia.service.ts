import { BadRequestException, Controller, Get, Injectable, Logger, OnModuleInit, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../users/user-role';
import { AiUsageLog } from './ai-usage.entity';
import { conectarRegistroDeUso, FilaDeUso } from './uso-ia';

/** Soles por dólar para mostrar el costo en moneda local (variable AI_TIPO_CAMBIO_PEN; es solo referencia). */
export const tipoDeCambioPen = (v: string | undefined = process.env.AI_TIPO_CAMBIO_PEN) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 3.7;
};

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class UsoIaService implements OnModuleInit {
    private readonly logger = new Logger(UsoIaService.name);
    private pendientes: FilaDeUso[] = [];
    private temporizador: NodeJS.Timeout | null = null;

    constructor(@InjectRepository(AiUsageLog) private readonly repo: Repository<AiUsageLog>) { }

    onModuleInit() {
        conectarRegistroDeUso((fila) => this.encolar(fila));
    }

    /** Se guardan en tandas cortas para no sumar una escritura a cada llamada de IA. Un fallo aquí solo se avisa en el log. */
    private encolar(fila: FilaDeUso) {
        this.pendientes.push(fila);
        if (this.pendientes.length >= 50) { void this.vaciar(); return; }
        if (!this.temporizador) {
            this.temporizador = setTimeout(() => { void this.vaciar(); }, 2000);
            this.temporizador.unref?.();
        }
    }

    async vaciar() {
        if (this.temporizador) { clearTimeout(this.temporizador); this.temporizador = null; }
        const tanda = this.pendientes.splice(0);
        if (!tanda.length) return;
        try {
            await this.repo.insert(tanda.map((f) => this.repo.create(f)));
        } catch (error: any) {
            this.logger.warn(`No se pudo guardar el consumo de IA (${tanda.length} llamadas): ${error?.message}`);
        }
    }

    /** Costo por usuario en el rango (días AAAA-MM-DD, ambos incluidos). Sin rango: todo lo registrado. */
    async resumen(filtro: { from?: string; to?: string; userId?: string }) {
        await this.vaciar();
        const dondes: string[] = []; const valores: any[] = [];
        if (filtro.from) { valores.push(filtro.from); dondes.push(`l."createdAt" >= $${valores.length}::date`); }
        if (filtro.to) { valores.push(filtro.to); dondes.push(`l."createdAt" < ($${valores.length}::date + 1)`); }
        if (filtro.userId) { valores.push(filtro.userId); dondes.push(`l."userId" = $${valores.length}::uuid`); }
        const where = dondes.length ? `WHERE ${dondes.join(' AND ')}` : '';

        const porUsuario: any[] = await this.repo.query(`
            SELECT l."userId" AS "userId", u.email AS email, u.name AS name,
                   COUNT(*)::int AS llamadas,
                   COALESCE(SUM(l."promptTokens"),0)::bigint AS "tokensEntrada",
                   COALESCE(SUM(l."cachedTokens"),0)::bigint AS "tokensEnCache",
                   COALESCE(SUM(l."completionTokens"),0)::bigint AS "tokensSalida",
                   COALESCE(SUM(l."costUsd"),0)::float AS "costoUsd",
                   COUNT(DISTINCT l."runId") FILTER (WHERE l.operation = 'generar-producto')::int AS "productosGenerados",
                   BOOL_AND(l."priceKnown") AS "preciosCompletos"
              FROM ai_usage_log l LEFT JOIN users u ON u.id = l."userId"
              ${where}
             GROUP BY l."userId", u.email, u.name
             ORDER BY "costoUsd" DESC`, valores);

        const porOperacion: any[] = await this.repo.query(`
            SELECT l.operation, l.model, COUNT(*)::int AS llamadas,
                   COALESCE(SUM(l."promptTokens"),0)::bigint AS "tokensEntrada",
                   COALESCE(SUM(l."completionTokens"),0)::bigint AS "tokensSalida",
                   COALESCE(SUM(l."costUsd"),0)::float AS "costoUsd"
              FROM ai_usage_log l ${where}
             GROUP BY l.operation, l.model ORDER BY "costoUsd" DESC`, valores);

        const cambio = tipoDeCambioPen();
        const redondear = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
        const usuarios = porUsuario.map((f) => {
            const costoUsd = Number(f.costoUsd);
            return {
                userId: f.userId, email: f.email ?? null, name: f.name ?? null,
                llamadas: f.llamadas,
                tokensEntrada: Number(f.tokensEntrada), tokensEnCache: Number(f.tokensEnCache), tokensSalida: Number(f.tokensSalida),
                costoUsd: redondear(costoUsd), costoPen: redondear(costoUsd * cambio, 2),
                productosGenerados: f.productosGenerados,
                // Todo el costo del usuario (fotos, categorías, fichas…) repartido entre los productos que generó.
                costoPorProductoUsd: f.productosGenerados ? redondear(costoUsd / f.productosGenerados) : null,
                preciosCompletos: f.preciosCompletos !== false,
            };
        });
        const total = usuarios.reduce((a, u) => a + u.costoUsd, 0);
        return {
            from: filtro.from ?? null, to: filtro.to ?? null, tipoDeCambioPen: cambio,
            totalUsd: redondear(total), totalPen: redondear(total * cambio, 2),
            usuarios,
            porOperacion: porOperacion.map((f) => ({
                operation: f.operation, model: f.model, llamadas: f.llamadas,
                tokensEntrada: Number(f.tokensEntrada), tokensSalida: Number(f.tokensSalida), costoUsd: redondear(Number(f.costoUsd)),
            })),
        };
    }
}

/** Costo real de IA por usuario. SOLO superadmin. */
@ApiTags('admin-ai-usage')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/ai-usage')
export class UsoIaController {
    constructor(private readonly uso: UsoIaService) { }

    @Get()
    @ApiOperation({ summary: 'Tokens y costo de IA por usuario (y por operación), con costo por producto generado' })
    @ApiQuery({ name: 'from', required: false, description: 'AAAA-MM-DD' })
    @ApiQuery({ name: 'to', required: false, description: 'AAAA-MM-DD' })
    @ApiQuery({ name: 'userId', required: false })
    resumen(@Query('from') from?: string, @Query('to') to?: string, @Query('userId') userId?: string) {
        if ((from && !FECHA.test(from)) || (to && !FECHA.test(to))) throw new BadRequestException('Las fechas deben ser AAAA-MM-DD.');
        return this.uso.resumen({ from, to, userId });
    }
}
