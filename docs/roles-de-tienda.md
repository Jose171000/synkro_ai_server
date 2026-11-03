# Roles y permisos de una tienda

Cada persona del equipo de una tienda tiene un **rol**, y un rol es un **conjunto de permisos**. Cada acceso de la aplicación
(ver ventas, publicar en un canal, descargar un Excel…) es un permiso suelto, así que más adelante cada tienda podrá crear
roles personalizados quitando o agregando permisos.

Código: `src/stores/permissions.ts` (catálogo y roles de fábrica), `src/stores/store-access.guard.ts` (`@RequirePermission`).
La tabla de permisos por ruta está fijada con una prueba (`src/stores/permisos-rutas.spec.ts`): cambiar el permiso de una ruta,
o agregar una ruta de tienda sin permiso, hace fallar las pruebas a propósito.

## Estado

| Fase | Qué es | Estado |
|---|---|---|
| 1 | Motor de permisos en el servidor; los tres roles de fábrica según esta tabla; huecos cerrados | **Hecha** |
| 2 | Roles personalizados de cada tienda: crear, editar, borrar y asignar | Pendiente |
| 3 | Pestaña «Roles» en la app y botones según permisos | Pendiente (la app ya oculta botones con `can()`) |

## Permisos y roles de fábrica

| Permiso | Qué permite | Lector | Editor | Dueño |
|---|---|:-:|:-:|:-:|
| `productos.ver` | Lista, ficha y estado de cada producto | Sí | Sí | Sí |
| `canales.ver` | Cuentas conectadas, publicaciones y cambios pendientes | Sí | Sí | Sí |
| `ventas.ver` | Lista de ventas y su detalle | Sí | Sí | Sí |
| `ventas.contacto` | Teléfono, correo y dirección de los clientes en cada venta | — | Sí | Sí |
| `analiticas.ver` | Dashboard, gráficos, mapa de calor, rankings | Sí | Sí | Sí |
| `costos.ver` | Envío, cupones y comisión | Sí | Sí | Sí |
| `productos.editar` | Crear y editar productos (IA, carga masiva, variantes) de cualquier producto de la tienda | — | Sí | Sí |
| `productos.eliminar` ⚠ | Borrar productos | — | Sí | Sí |
| `productos.descargar` | Excel de productos y de contenido IA | — | Sí | Sí |
| `inventario.editar` | Stock, precio, promoción y precio web (con modo revisión queda pendiente) | — | Sí | Sí |
| `canales.publicar` ⚠ | Publicar, pausar y reactivar en canales | — | Sí | Sí |
| `canales.conectar` ⚠ | Conectar y desconectar cuentas, importar publicaciones e historial | — | — | Sí |
| `cambios.aprobar` ⚠ | Aprobar o rechazar cambios y activar el modo revisión | — | — | Sí |
| `ventas.registrar` | Ventas manuales (crear, editar, eliminar, importar) y «Actualizar ventas ahora» | — | Sí | Sí |
| `ventas.descargar` | Excel de ventas | — | Sí | Sí |

⚠ = permiso delicado: la pantalla de roles pedirá una advertencia al darlo.

**Fijo, fuera del catálogo y sin poder delegarse:** gestionar el equipo (invitar, cambiar roles, crear roles, enlace público,
nombre de la tienda) y ver el plan y los cobros de la tienda. Es siempre del dueño y se comprueba por rol.

El superadmin de la plataforma entra a cualquier tienda como dueño, con todos los permisos.

## Dependencias

Marcar un permiso marca también lo que necesita (`DEPENDENCIAS`): por ejemplo `inventario.editar` necesita `productos.ver` y
`canales.ver`. La pantalla de roles lo hará sola.

## Decisiones acordadas

* Los roles personalizados son **de cada tienda**.
* Editor y Lector **quedan fijos**; para algo distinto se crea un rol personalizado a partir de ellos.
* La gestión del equipo **no se delega**.
* **Ver también es un permiso:** hay permisos para ver productos, canales, ventas, analíticas y costos.
* Al elegir un rol de fábrica en la pantalla de roles se marcan todos sus permisos. Si se quita o agrega uno, deja de ser de
  fábrica y pasa a **Personalizado** (se le pone nombre y se guarda como rol reutilizable de la tienda). Si el conjunto vuelve a
  ser exactamente el de un rol de fábrica, vuelve a ser ese rol (`rolDeFabricaIgualA`).
* Reglas fijas: siempre queda al menos un dueño; un rol en uso no se borra hasta mover a sus personas; un cambio de rol vale desde
  la siguiente petición (no se guarda en el token).

## Qué cambió respecto a los roles anteriores (fase 1)

* El **editor** ahora puede publicar en canales y registrar ventas manuales (antes solo el dueño), y editar **cualquier** producto de
  la tienda (antes solo los que había subido él).
* El **lector** ya no puede descargar Excel de productos ni de ventas, ni usar la carga masiva (antes sí: no exigía rol).
* **Productos por ID** (abrir, editar, usar la IA): el acceso es de la tienda, no de quien lo subió. Los productos anteriores a las
  tiendas, sin tienda, solo los ve su dueño. La IA consulta los canales de quien subió el producto, no los de quien pulsa el botón.
* `ventas.contacto` es un permiso nuevo que antes era una regla escondida («el lector no ve el contacto de los clientes»).
* `costos.ver` ya existe en el catálogo, pero **todavía no se aplica**: ningún rol de fábrica puede quitarlo. Se aplicará en la fase 2,
  cuando haya roles que no lo tengan.

## Cómo agregar una ruta nueva de tienda

1. Pon `@UseGuards(StoreAccessGuard)` y `@RequirePermission('…')` con el permiso que corresponda (no uses `@RequireStoreRole`, que
   queda solo para la gestión del equipo).
2. Agrega la ruta a `TABLA` en `permisos-rutas.spec.ts`.
3. Si hace falta un permiso nuevo: `permissions.ts` (catálogo, dependencias, descripción y roles de fábrica), el frontend
   (`src/lib/store-permissions.ts`) y esta tabla.
