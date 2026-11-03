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

Texto del aviso (v. 2026-11-03; vive en el frontend, `src/lib/privacy-notice.ts`, y debe llevar la misma versión que el
servidor; revisarlo con un abogado):

> **Aviso de privacidad y uso de datos.** Para mejorar Synkro y darte mejor soporte, registramos cómo usas la plataforma: tus
> ingresos, las secciones que abres, los botones que tocas y las acciones que realizas, con su fecha y hora. No guardamos lo
> que escribes, tus contraseñas ni los datos personales de tus clientes. Esta información la ven solo los administradores de
> Synkro y se usa únicamente para analizar el uso del servicio. Se conserva 90 días en detalle; después solo se guardan
> resúmenes (por ejemplo, cuántas veces se usó cada sección), hasta por 2 años. Puedes escribirnos a synkroaiecom@gmail.com
> para consultar, corregir o pedir la eliminación de tus datos.

Dónde se muestra: casilla obligatoria en `Register` (tienda independiente) y `RegisterInvited` (invitado), y una ventana que
bloquea el panel (`ActivityTracker`) a quien ya tenía cuenta hasta que acepte o cierre sesión.

## Datos y retención

| Tabla | Contenido | Se conserva |
|---|---|---|
| `activity_events` | cada vista, clic, latido, acción e ingreso | 90 días |
| `activity_daily` | por día, persona, pantalla y elemento: cuántas veces y posición media | 2 años |
| `activity_hourly` | por día y hora (Lima): eventos y segundos activos | 2 años |
| `activity_sessions` | cada visita: inicio, último movimiento y segundos activos | 2 años |
| `privacy_consents` | aceptaciones del aviso | mientras exista la cuenta |
| `activity_layouts` | plano de cada pantalla (forma de sus bloques, sin texto); una fila por pantalla | se renueva cada 24 h como mucho |

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

## Plano de las pantallas

Para dibujar los mapas de clics sobre la estructura real de cada pantalla, el navegador manda **su plano**: una lista de
bloques `{ k, x, y, w, h }` donde `k` es uno de `titulo, tabla, pestanas, grafico, imagen, campo, boton, tarjeta` y la posición
y el tamaño van en milésimas de la zona de contenido. **Nunca texto**: del DOM solo se leen etiqueta, rol y tamaño
(`src/lib/activity-layout.ts`, probado con `npm run probar:plano`); el servidor repite la validación (`validarPlano`) y
descarta cualquier otro campo.

* `POST /activity/layout` (cualquier usuario autenticado, solo si aceptó el aviso): una vez por pantalla y día, desde pantallas
  anchas (≥ 1024 px), 2,5 s después de abrirla. Se guarda un plano por pantalla y no se renueva antes de 24 h
  (`HORAS_ENTRE_PLANOS`); no queda anotado quién lo mandó.
* `GET /admin/activity/layout?screen=` (solo `admin`): `{ plano: { bloques, ancho, alto, tomadoEl } | null }`.
* El mapa de Superadmin y el PDF dibujan el plano en gris con los clics encima; sin plano (nadie abrió aún la pantalla desde un
  computador) se dibuja solo la posición de lo tocado.

## Fases

1. **Servidor (hecha):** tablas, consentimiento, registro, resúmenes, limpieza, consultas solo para admin, pruebas.
2. **Navegador y aviso (hecha):** rastreador propio (`src/lib/activity-tracker.ts`), casilla en `Register` y `RegisterInvited`,
   ventana para quien ya tenía cuenta. Los clics se nombran por el texto fijo del control o por `data-track`; el contenido de
   filas, tarjetas y campos nunca se usa (`src/lib/activity-naming.ts`, probado con `npm run probar:etiquetas`). Para encender la
   casilla obligatoria en el servidor: `PRIVACY_CONSENT_REQUIRED=true` (solo después de publicar el frontend nuevo).
3. **Pantalla Superadmin › Actividad (hecha):** pestaña «Actividad» dentro de Superadmin, visible solo con rol `admin`
   (`src/components/admin/activity/` en el frontend). Filtros: persona o todas (promedio por persona o suma), roles de
   plataforma y de tienda (varios), periodo. Muestra indicadores, secciones y funciones más usadas, cuadrícula día × hora,
   mapa de clics por pantalla (con interruptor y lista), tabla de personas y línea de tiempo de una persona. Los controles de
   ventanas emergentes no tienen posición: salen en la lista como «emergente» y no se dibujan en el mapa. Los mapas se dibujan
   sobre el plano de la pantalla (ver arriba).
4. Descargas Excel y PDF.
