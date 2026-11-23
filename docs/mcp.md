# MCP de Synkro

Un servidor MCP dentro de la misma app: un asistente (Claude Desktop, Claude Code, Cursor…) puede **consultar** una tienda de Synkro.
Código: `src/mcp/`. **Fase 1: solo lectura.** Ninguna herramienta edita, publica ni aprueba nada.

## Estado

| Fase | Qué es | Estado |
|---|---|---|
| 1 | Claves por tienda, `POST /api/v1/mcp`, 8 herramientas de lectura | **Hecha** (falta probarla con un cliente real y la pantalla de claves en la app) |
| 2 | Escrituras seguras: inventario (respeta el modo revisión), aprobar/rechazar cambios | Pendiente |
| 3 | Acciones sobre canales (publicar, pausar, descuentos), siempre con vista previa y confirmación | Pendiente; solo si se decide |
| 4 | OAuth (conectar con un clic, sin copiar claves) | Opcional |

## Cómo funciona

```
Cliente MCP ── POST /api/v1/mcp  (Authorization: Bearer syk_…) ──▶ McpController
   ApiKeysService.autenticar: hash SHA-256 → fila de store_api_keys
   StoresService.requireAccess(creador, tienda)      ← la misma puerta que usa toda la app
   permisos efectivos = permisos de la clave ∩ permisos que su creador tiene HOY
   un McpServer por petición (sin sesión) con solo las herramientas que esos permisos permiten
```

* **Sin sesión:** cada petición se autentica y se atiende sola. Sirve con varias instancias del servidor.
* **Dónde está:** `/api/v1/mcp` (con el prefijo normal). `TransformInterceptor` deja pasar esa ruta, porque es JSON-RPC y envolverla la rompe.
* **`GET` y `DELETE`** responden 405: sin sesión no hay flujo de eventos que abrir ni sesión que cerrar.
* **401** clave mala, caducada o revocada (siempre el mismo mensaje). **403** clave válida cuyo creador perdió todo lo que ella permitía.

## Claves

Las gestiona **solo el dueño** de la tienda (se comprueba por rol, como el equipo y los roles). Rutas, bajo `/stores`:

* `GET mcp/permissions`: permisos que puede llevar una clave.
* `GET :storeId/api-keys`: las claves de la tienda (nombre, prefijo, permisos, caducidad, último uso). Nunca la clave completa.
* `POST :storeId/api-keys` `{ name, permissions?, expiresInDays? }`: la clave completa viene **una sola vez** en `key`.
* `DELETE :storeId/api-keys/:id`: revoca; deja de servir en la siguiente llamada.

Reglas (`src/mcp/api-keys.service.ts`, fijadas con pruebas):

* Se guarda solo el hash. El prefijo (`syk_` + 8 caracteres) sirve para reconocerla en la lista.
* **Solo permisos de lectura:** `productos.ver`, `canales.ver`, `ventas.ver`, `ventas.contacto`, `analiticas.ver`, `costos.ver`. Los de escritura se rechazan al crearla.
* **Por defecto** lleva `productos.ver`, `canales.ver`, `ventas.ver` y `analiticas.ver`: **sin datos de contacto de clientes ni costos**; hay que pedirlos a propósito.
* No se le pueden dar permisos que quien la crea no tenga. Lo que falta para un permiso (`ventas.contacto` necesita `ventas.ver`) se agrega solo.
* **Techo = su creador:** en cada llamada se vuelve a comprobar a quien la creó. Si lo sacan de la tienda o le bajan el rol, la clave pierde poder al instante.
* Hasta 10 claves activas por tienda; caducidad opcional de 1 a 365 días.
* Una clave que se filtra se revoca desde la lista; no hay que cambiar nada más.

## Herramientas (fase 1)

Cada una exige el mismo permiso que la app exige para esa información. La tabla está fijada en `src/mcp/mcp-tools.spec.ts`: agregar una herramienta sin permiso o cambiar uno hace fallar las pruebas a propósito. El asistente solo ve las herramientas de sus permisos.

| Herramienta | Qué da | Permiso |
|---|---|---|
| `listar_productos` | Productos con precio, stock y categoría; búsqueda y paginación | `productos.ver` |
| `ver_producto` | Ficha, fotos, dónde está publicado y qué le falta por canal | `productos.ver` |
| `listar_ventas` | Ventas con productos, estado y envío | `ventas.ver` |
| `ver_venta` | Detalle de una venta | `ventas.ver` |
| `resumen_negocio` | Canales, catálogo, ventas del mes vs. anterior, stock en riesgo | `analiticas.ver` |
| `reporte_ventas` | Ventas por día, canal y cuenta | `analiticas.ver` |
| `productos_ganadores` | Lo más vendido y cuánto dura el stock | `analiticas.ver` |
| `listar_cambios_pendientes` | Cambios de precio/stock/promo en espera de aprobación (no aprueba) | `canales.ver` |

* **Contacto y costos:** se pasa al servicio de ventas el acceso real de la clave, así que teléfono, correo y dirección solo salen con `ventas.contacto`, y envío, cupones y comisión solo con `costos.ver` (igual que en la app).
* **Tamaño:** máximo 50 resultados por llamada y 60 000 caracteres de respuesta; más se recorta con un aviso. Los productos se resumen (sin atributos de IA ni datos internos).
* **Errores:** los mensajes de la app (en español) se muestran tal cual; cualquier otro error sale genérico, sin detalles internos.
* `resumen_negocio` no incluye los avisos: son notificaciones personales de quien creó la clave, no de la tienda.

## Conectar un cliente

Con Claude Code:

```bash
claude mcp add --transport http synkro https://TU-API/api/v1/mcp --header "Authorization: Bearer syk_…"
```

Con otros clientes: URL `https://TU-API/api/v1/mcp`, transporte «Streamable HTTP» y la cabecera `Authorization: Bearer syk_…`.

## Cosas a saber

* **Datos de clientes finales:** lo que el asistente lee pasa al modelo que use quien tiene la clave. Por eso `ventas.contacto` no va por defecto.
* **Límite de peticiones:** hoy el del servidor (por IP, 10/s y 120/min). Un límite por clave queda pendiente.
* **Registro de uso:** cada llamada queda en el log del servidor (herramienta, nombre de la clave y tienda) y la clave guarda su último uso. No entra en «Actividad de usuarios», que mide el uso de la pantalla.
* **Pendiente de la fase 1:** la pantalla de claves en la app (hoy se gestionan con las rutas de arriba) y probar con un cliente MCP real y una tienda real.
* Dependencias: `@modelcontextprotocol/sdk` y `zod`. El SDK carga bien bajo CommonJS (comprobado con pruebas de punta a punta).
