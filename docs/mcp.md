# MCP de Synkro

Un servidor MCP dentro de la misma app: un asistente (Claude Desktop, Claude Code, Cursor…) puede **consultar** una tienda de Synkro y, si la clave lo permite, **crear productos**.
Código: `src/mcp/`. Ninguna herramienta publica, cambia inventario, aprueba ni borra.

## Estado

| Fase | Qué es | Estado |
|---|---|---|
| 1 | Claves por tienda, `POST /api/v1/mcp`, 8 herramientas de lectura | **Hecha** |
| 1b | MCP de plataforma para superadmins (`/mcp/admin`, claves `sya_`) y vista de todas las claves | **Hecha** (probada en producción con curl el 2026-11-24) |
| 2 | Productos: crear (simples y con variantes), editar y completar con IA los que no están en ningún canal | **Hecha** (falta probarla con una clave real) |
| 2b | Subir fotos desde el celular o la PC con un enlace de un solo uso | **Hecha** (falta probarla con una clave real) |
| 3 | Inventario y precios, siempre dejando el cambio pendiente de aprobación | Pendiente |
| 4 | Canales: publicar, pausar, descuentos, con vista previa y confirmación | Pendiente |
| 5 | Gestión: ventas manuales, CRM, cobros, registros | Pendiente |
| — | OAuth (conectar con un clic, sin copiar claves) | Opcional |

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
* **Permisos posibles:** `productos.ver`, `canales.ver`, `ventas.ver`, `ventas.contacto`, `analiticas.ver`, `costos.ver` y una sola escritura, `productos.editar`. El resto se rechaza al crearla.
* **Por defecto** lleva `productos.ver`, `canales.ver`, `ventas.ver` y `analiticas.ver`: **sin datos de contacto de clientes ni costos**; hay que pedirlos a propósito.
* No se le pueden dar permisos que quien la crea no tenga. Lo que falta para un permiso (`ventas.contacto` necesita `ventas.ver`) se agrega solo.
* **Techo = su creador:** en cada llamada se vuelve a comprobar a quien la creó. Si lo sacan de la tienda o le bajan el rol, la clave pierde poder al instante.
* Hasta 10 claves activas por tienda; caducidad opcional de 1 a 365 días.
* Una clave que se filtra se revoca desde la lista; no hay que cambiar nada más.

## Escritura de productos (fase 2)

Solo en el MCP de tienda, solo con `productos.editar` (no va por defecto). Además, quien creó la clave debe conservar la sección Productos. El MCP de plataforma no la tiene.

| Herramienta | Qué hace |
|---|---|
| `crear_enlace_para_fotos` | Enlace de un solo uso para subir fotos desde el celular o la PC |
| `ver_fotos_subidas` | Las direcciones de lo subido con ese enlace (solo consulta) |
| `crear_producto` | Producto simple, con 1 a 8 fotos |
| `crear_producto_con_variantes` | Grupo con hasta 50 variantes y 30 fotos distintas; no usa IA |
| `agregar_variantes` | A un producto o grupo que no está en ningún canal |
| `editar_producto` | Solo nombre, descripción, categoría y subcategoría, si no está en ningún canal |
| `generar_contenido_ia` | La IA completa solo lo vacío, si no está en ningún canal |

* **«En ningún canal»** = ni el producto ni las variantes de su grupo tienen un vínculo con un canal. Los publicados se editan en la app.
* **Nada llega a un canal:** estas herramientas llaman a los servicios de productos, no a la sincronización.
* **Fotos:** enlaces `https` directos a JPG (máx. 10 MB, 2000×2000). Se descargan sin redirecciones y solo desde direcciones públicas (`imagenes-seguras.ts`) y se suben a Cloudinary. No se aceptan archivos ni fotos pegadas en el chat: para esas está el enlace de subida.
* **Sin duplicados:** la misma creación repetida en 15 minutos devuelve lo ya creado.
* **Topes:** 30 cambios por hora por clave, 200 al día por tienda y 20 generaciones con IA al día por tienda.
* **Registro:** tabla `mcp_write_log` (se anota antes de ejecutar). El dueño lo ve en la pestaña «Conexión MCP» (`GET /stores/:storeId/mcp-changes`, últimos 100).
* Si Redis o el registro fallan, no se escribe.

### Enlace para subir fotos

```
crear_enlace_para_fotos → https://TU-API/api/v1/mcp/subir-fotos#<secreto>
la persona abre, elige o toma fotos, «Subir»
ver_fotos_subidas(subidaId) → direcciones → crear_producto
```

* El secreto va detrás de `#` (no queda en los registros) y se manda como cabecera. Sirve 30 minutos y se gasta al subir; si la subida falla, sigue valiendo.
* Antes de recibir un archivo se comprueba que la clave siga activa y su creador conserve `productos.editar`.
* El navegador convierte cada foto a JPG de hasta 2000×2000, así sirven las del celular. Máximo 30 por enlace.
* Las fotos subidas se recuerdan 24 horas, solo para esa tienda. Las que no se usen quedan en Cloudinary.
* Necesita `PUBLIC_API_URL` (o el dominio que da Railway).
* Código: `subida-fotos.*`.

## Herramientas de lectura

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

## MCP de plataforma (superadmins)

Para consultar **toda la agencia**, no una tienda. Entrada: `POST /api/v1/mcp/admin`, con claves `sya_…` (las de tienda son `syk_…`: una no sirve en el
punto de la otra). Código: `src/mcp/mcp-plataforma.*`, `platform-tools.ts`, `permisos-plataforma.ts`. También es **solo lectura**.

* **Quién:** solo un superadmin (rol `admin`) la crea, desde la pantalla de superadmin. Está atada a su creador y **el rol se lee de la base en cada
  llamada**: si lo bajan de rol o lo desactivan, la clave muere en la siguiente llamada (y vuelve a servir si recupera el rol).
* **Caducidad obligatoria**, de 1 a 90 días, y hasta 20 claves de plataforma activas. Es una llave maestra: no debe vivir para siempre.
* **Apagarla:** `MCP_PLATAFORMA_ACTIVO=false` en el servidor → `/mcp/admin` responde 404 (el MCP de las tiendas no se toca).
* **Permisos propios** (no son los de una tienda): `clientes.ver`, `finanzas.ver` (arrastra a `clientes.ver`) y `sistema.ver`. Por defecto, solo `clientes.ver`.
  **No hay `actividad.ver` a propósito:** el aviso de privacidad promete que la actividad de los usuarios solo la ven los administradores, y con el MCP pasaría
  al modelo de IA de quien tenga la clave. Para abrirla hay que actualizar antes el aviso.

| Herramienta | Qué da | Permiso |
|---|---|---|
| `listar_clientes`, `ver_cliente` | Cuentas, tiendas, canales y productos. Plan y pagos solo con finanzas | `clientes.ver` |
| `listar_tiendas` | Id, nombre y dueño de cada tienda (el id sirve para las `tienda_…`) | `clientes.ver` |
| `solicitudes_de_registro` | Altas pendientes o rechazadas (sin teléfono; no aprueba ni rechaza) | `clientes.ver` |
| `cartera_agencia`, `ver_tienda_en_cartera` | Ventas por cliente, plan, próximo pago, comisión, cobros vencidos | `finanzas.ver` |
| `resumen_financiero` | Total histórico, ingresos del mes, MRR | `finanzas.ver` |
| `cobros_del_periodo`, `tendencia_de_cobros` | Liquidaciones por periodo y últimos 12 meses | `finanzas.ver` |
| `estado_del_sistema` | Memoria y colas de Redis | `sistema.ver` |
| `listar_claves_mcp` | Todas las claves (nunca su valor) | `sistema.ver` |
| `tienda_listar_productos`, `tienda_ver_producto`, `tienda_listar_ventas`, `tienda_ver_venta`, `tienda_resumen_negocio`, `tienda_reporte_ventas`, `tienda_productos_ganadores`, `tienda_listar_cambios_pendientes` | Las 8 de tienda, de **cualquier** tienda, con `tiendaId` | `clientes.ver` (con `costos.ver` de la tienda si la clave tiene `finanzas.ver`) |

* **Dentro de cada tienda** la clave ve lo que su permiso dice, **no** lo que vería un dueño: nunca el teléfono, correo ni dirección de los compradores
  (`ventas.contacto`), y los costos de envío y cupones solo con `finanzas.ver`.
* **No salen:** contraseñas, teléfonos de clientes, enlaces a hojas de reportes, el enlace público de las tiendas, la actividad de usuarios.
* **Fuera de alcance (no escribe):** registrar o borrar pagos, borrar clientes, resetear contraseñas, aprobar o rechazar altas, cambiar roles, limpiar Redis.
  Una prueba (`platform-tools.spec.ts`) fija la tabla de permisos y que ninguna herramienta lleve nombre de escritura.

## Todas las claves, para el superadmin

Solo rol `admin` (`src/mcp/admin-api-keys.controller.ts`):

* `GET /admin/api-keys?storeId=&kind=&estado=`: **todas** las claves (de tienda y de plataforma), con tienda, quién la creó, permisos, estado
  (`activa`, `revocada`, `caducada`) y último uso. **Nunca el valor de la clave**: solo se guarda su hash, y ni un superadmin puede recuperarlo.
* `GET /admin/api-keys/permissions`: permisos de una clave de plataforma, con su descripción y los topes.
* `POST /admin/api-keys`: crea una clave de plataforma (la caducidad es obligatoria).
* `DELETE /admin/api-keys/:id`: revoca **cualquier** clave. Queda en el log quién la revocó.

Un superadmin además entra a cualquier tienda como dueño, así que puede crear, listar y revocar las claves de una tienda concreta con las rutas de `/stores/:storeId/api-keys`.

## Cuentas con varias tiendas

Una clave de tienda es de **una** tienda. Quien administra varias tiendas crea una clave en cada una (selecciona la tienda, «Gestionar» → «Conexión MCP») y las conecta
con nombres distintos, por ejemplo `synkro-jolijoli` y `synkro-chumpi`. Cada una ve solo su tienda. Una clave que cubra varias tiendas de un mismo dueño no existe todavía.

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
* Dependencias: `@modelcontextprotocol/sdk` y `zod`. El SDK carga bien bajo CommonJS (comprobado con pruebas de punta a punta).
