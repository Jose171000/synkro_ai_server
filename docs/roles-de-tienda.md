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
| 2 | Roles personalizados de cada tienda: crear, editar, borrar y asignar (servidor); `costos.ver` se aplica | **Hecha** (sin pantalla todavía) |
| 3 | Pestaña «Roles» en la app, miembros e invitaciones con el nombre del rol, menú y pestañas según «ver», y ocultar lo que `costsHidden` indica | **Hecha** |

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

## Roles personalizados (fase 2)

Código: `src/stores/store-roles.service.ts`, entidad `StoreCustomRole` (`store_custom_roles`), migración `1791400000000`.

* Los gestiona **solo el dueño** (se comprueba por rol, no por permiso: no se delega). Un rol personalizado es de **una tienda**.
* **Rutas** (todas bajo `/stores`):
  * `GET permissions/catalog`: catálogo de permisos (título, ayuda, grupo, si es delicado, de qué depende) y roles de fábrica.
  * `GET :storeId/roles`: roles de fábrica y personalizados, con cuántas personas e invitaciones tiene cada uno.
  * `POST :storeId/roles` `{ name, permissions[] }`, `PATCH :storeId/roles/:roleId`, `DELETE :storeId/roles/:roleId`.
  * Asignar: `PATCH :storeId/members/:userId` y `POST :storeId/invitations` aceptan `role` (editor o viewer) **o** `customRoleId`, uno solo.
* **Validaciones:** nombre de 2 a 40 letras, sin `< > @`, único en la tienda sin distinguir mayúsculas, y que no sea el de un rol de
  fábrica (dueño, editor, lector, personalizado…). Permisos que existan, al menos uno; los que otro necesita se agregan solos y la
  respuesta lo dice (`addedAutomatically`). Un conjunto **idéntico** al de un rol de fábrica se rechaza: ese conjunto ES el rol de
  fábrica. Máximo 20 roles por tienda.
* **Borrar:** si alguien lo tiene o hay una invitación pendiente con él, no se puede (la clave foránea es `RESTRICT`); hay que cambiar antes
  a esas personas.
* **Cómo se guarda quién tiene qué:** `store_members.customRoleId` (y `store_invitations.customRoleId`). Con rol personalizado la columna
  `role` queda en **`viewer`**, el rol de fábrica con menos poder, para que ninguna regla que mire solo el nombre del rol le dé de más.
  Los permisos reales salen del rol y se leen **en cada petición**: un cambio vale desde la siguiente acción, sin volver a entrar.
* Un permiso retirado del catálogo nunca da acceso (se descarta al leer el rol).
* Efectos colaterales: la actividad de usuarios registra a esa persona con rol de tienda «viewer», y el aviso de venta por correo solo
  llega a quien tiene `ventas.ver`.

### `costos.ver` (aplicado en la fase 2)

Sin este permiso:
* cada venta trae `costsHidden: true` y `shippingPaid`, `shippingSellerCost`, `shippingType`, `discountAmount` y `discountSellerFunded` vacíos;
* el Excel de ventas no trae las columnas de envío ni cupones y el total es solo lo vendido;
* el reporte de ventas (`/reports/sales`) trae `costsHidden: true`, `shipping` y `discounts` vacíos, y las ventas **nunca** suman el envío.

La app oculta con `costsHidden` el interruptor «Incluir envío» y la sección «Envíos y cupones» de Analíticas, y sin `costos.ver` también el filtro de envío de Ventas. El envío de cada línea de producto también viene vacío.

## La app (fase 3)

Código en el frontend: `src/components/stores/` (`RolesTab`, `RoleEditor`, `RolePicker`, `ManageStoreDialog`), `src/lib/store-permissions.ts` (lógica de marcar y quitar con dependientes; `npm run probar:permisos`) y `can()` en `StoreContext`.

* **Pestaña «Roles»** (solo el dueño, en «Equipo y enlace» de la tienda): roles de fábrica (fijos, con su lista de permisos) y roles personalizados con cuántas personas tiene cada uno; crear, editar y borrar.
* **Editor de roles:** «Empezar desde» En blanco, Lector o Editor marca sus permisos. Quitar o agregar uno lo vuelve «Personalizado» y pide nombre; si vuelve a coincidir con uno de fábrica, vuelve a ser ese rol y no se puede guardar. Marcar un permiso marca lo que necesita; quitar uno quita lo que no puede vivir sin él (con aviso). Los permisos delicados llevan etiqueta y una advertencia con lo que podrá hacer el rol.
* **Invitar y cambiar rol:** el selector ofrece los roles de fábrica y los de la tienda; la lista de miembros, las invitaciones, el selector de tiendas y las páginas de invitación muestran el nombre real del rol.
* **«Ver» como permiso:** el menú oculta Productos sin `productos.ver`, IA Productos sin `productos.editar`, Analíticas sin `analiticas.ver` y Marketplaces sin `canales.ver` ni `ventas.ver`; las pestañas de Marketplaces (Canales, Tablero, Revisión con `canales.ver`; Ventas con `ventas.ver`) igual. El dashboard avisa si falta `analiticas.ver`.

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
  la siguiente petición (no se guarda en el token). El rol de dueño no se puede cambiar ni quitar, así que nunca recibe un rol personalizado.

## Qué cambió respecto a los roles anteriores (fase 1)

* El **editor** ahora puede publicar en canales y registrar ventas manuales (antes solo el dueño), y editar **cualquier** producto de
  la tienda (antes solo los que había subido él).
* El **lector** ya no puede descargar Excel de productos ni de ventas, ni usar la carga masiva (antes sí: no exigía rol).
* **Productos por ID** (abrir, editar, usar la IA): el acceso es de la tienda, no de quien lo subió. Los productos anteriores a las
  tiendas, sin tienda, solo los ve su dueño. La IA consulta los canales de quien subió el producto, no los de quien pulsa el botón.
* `ventas.contacto` es un permiso nuevo que antes era una regla escondida («el lector no ve el contacto de los clientes»).

## Cómo agregar una ruta nueva de tienda

1. Pon `@UseGuards(StoreAccessGuard)` y `@RequirePermission('…')` con el permiso que corresponda (no uses `@RequireStoreRole`, que
   queda solo para la gestión del equipo).
2. Agrega la ruta a `TABLA` en `permisos-rutas.spec.ts`.
3. Si hace falta un permiso nuevo: `permissions.ts` (catálogo, dependencias, descripción y roles de fábrica), el frontend
   (`src/lib/store-permissions.ts`) y esta tabla.
