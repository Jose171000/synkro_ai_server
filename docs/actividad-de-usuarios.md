# Actividad de los usuarios (solo superadmin)

Registro propio —sin terceros— de cómo usan Synkro las personas de la plataforma, con mapas de calor de clics, horarios y
rankings. **Solo el superadmin (rol `admin`) lo ve y lo descarga**; el contador, el moderador y los usuarios no.

## Qué se registra y qué no

| Se registra | No se registra nunca |
|---|---|
| Ingresos (login) y cierres de sesión | Lo que la persona escribe en los campos |
| Qué sección abrió (`view`) | Contraseñas |
| En qué elemento hizo clic (`click`): etiqueta + posición en la pantalla (milésimas) | Nombres, teléfonos, direcciones o documentos de clientes finales |
| Tiempo activo (`ping`, solo con la pestaña visible) | El contenido de las pantallas ni de las respuestas |
| Acciones que cambian datos en el servidor (`action`) con nombre legible | Cuerpos de las peticiones |

Las etiquetas de pantallas y elementos pasan por `limpiarEtiqueta` (`activity-validation.ts`): minúsculas, sin tildes, y se
**rechaza** lo que parece un correo, un número de 5 o más dígitos o un UUID. Un clic sin etiqueta aprovechable queda como `otros`.

## Aviso de privacidad y consentimiento

* Versión vigente: `PRIVACY_VERSION` (`activity.constants.ts`). Si el texto cambia, se sube y todos vuelven a aceptar.
* **Sin aceptación de la versión vigente no se guarda nada** de esa persona: ni los eventos del navegador (`POST /activity/events`
  responde `requiereAviso: true`) ni las acciones del servidor.
* Registro: `acceptPrivacy: true` en `POST /auth/register` (sirve para tienda independiente e invitado, que usan el mismo
  endpoint). Se **exige** con la variable `PRIVACY_CONSENT_REQUIRED=true`; hasta que el formulario nuevo esté publicado se deja
  apagada para no rechazar registros hechos con el formulario anterior.
* Quien ya tenía cuenta acepta con `POST /activity/consent` (ventana al próximo ingreso). `GET /activity/consent` dice si falta.
* Queda en `privacy_consents`: persona, versión, fecha y vía (`registro`, `invitacion`, `aviso`).

Texto del aviso (v. 2026-11-03; revisarlo con un abogado y poner el correo de contacto):

> **Aviso de privacidad y uso de datos.** Para mejorar Synkro y darte mejor soporte, registramos cómo usas la plataforma: tus
> ingresos, las secciones que abres, los botones que tocas y las acciones que realizas, con su fecha y hora. No guardamos lo
> que escribes, tus contraseñas ni los datos personales de tus clientes. Esta información la ven solo los administradores de
> Synkro, se conserva 90 días en detalle y se usa únicamente para analizar el uso del servicio. Puedes escribirnos a [correo]
> para consultar, corregir o pedir la eliminación de tus datos.

## Datos y retención

| Tabla | Contenido | Se conserva |
|---|---|---|
| `activity_events` | cada vista, clic, latido, acción e ingreso | 90 días |
| `activity_daily` | por día, persona, pantalla y elemento: cuántas veces y posición media | 2 años |
| `activity_hourly` | por día y hora (Lima): eventos y segundos activos | 2 años |
| `activity_sessions` | cada visita: inicio, último movimiento y segundos activos | 2 años |
| `privacy_consents` | aceptaciones del aviso | mientras exista la cuenta |

Cada fila copia el **rol de plataforma** y el **rol en la tienda** que la persona tenía en ese momento, para poder filtrar por
ambos. Mantenimiento (`ActivityService.mantenimiento`, cada 6 h con candado en Redis, una vez al día): recalcula los resúmenes de
todo el detalle guardado **antes** de borrar lo vencido. Las consultas leen los resúmenes, no el detalle.

## Endpoints

* `POST /activity/events` — cualquier usuario autenticado; lote de hasta 100 eventos.
* `GET|POST /activity/consent` — cualquier usuario autenticado.
* `GET /admin/activity/options | overview | people | screens | clicks` — **solo `admin`**.
  Filtros comunes: `from`, `to` (AAAA-MM-DD, día de Lima, máx. 730 días), `userId`, `platformRoles` (`admin,contador,moderator,user`),
  `storeRoles` (`owner,editor,viewer`), `mode` (`average` | `total`). Con todas las personas y `average`, cada persona pesa lo mismo
  (se normaliza el mapa de cada una y luego se promedia).

## Mapas de clics

Cada pantalla con clics registrados tiene mapa (`GET /admin/activity/screens` las lista). La posición de cada elemento se
aprende de los propios clics (posición media del elemento en la pantalla), así que no hace falta dibujar una maqueta por
pantalla: se agregan solas en cuanto hay actividad.

## Fases

1. **Servidor (hecha):** tablas, consentimiento, registro, resúmenes, limpieza, consultas solo para admin, pruebas.
2. Navegador y aviso: registro de clics en la app, casilla en `Register` y `RegisterInvited`, ventana para quien ya tenía cuenta.
3. Pantalla Superadmin › Actividad.
4. Descargas Excel y PDF.
