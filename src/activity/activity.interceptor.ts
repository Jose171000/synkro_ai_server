import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { ActivityService } from './activity.service';
import { esAccion, nombreDeAccion, rutaExcluida } from './activity-acciones';

/**
 * Anota cada acción que cambia datos (crear, editar, borrar, subir…) de quien está autenticado, cuando sale bien. Guarda el
 * nombre de la acción y la pantalla, nunca el contenido de la petición ni la respuesta. No espera a la base de datos ni
 * puede hacer fallar la petición.
 */
@Injectable()
export class ActivityInterceptor implements NestInterceptor {
    constructor(private readonly activity: ActivityService) { }

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        if (context.getType() !== 'http') return next.handle();
        const req = context.switchToHttp().getRequest();
        return next.handle().pipe(tap(() => {
            try {
                const ruta: string | undefined = req.route?.path;
                if (!req.user?.id || !ruta || !esAccion(req.method) || rutaExcluida(ruta)) return;
                const { accion, pantalla } = nombreDeAccion(req.method, ruta);
                void this.activity.anotar(
                    { userId: req.user.id, platformRole: req.user.role, storeId: req.store?.storeId ?? null, storeRole: req.store?.role ?? null },
                    'action', accion, pantalla,
                );
            } catch { /* anotar la actividad nunca debe afectar a la petición */ }
        }));
    }
}
