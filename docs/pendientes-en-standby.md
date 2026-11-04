# Pendientes en standby (al 2026-11-04)

Lista ordenada de todo lo que quedó en pausa. Cada punto dice en qué estado está, qué falta y qué se necesita para retomarlo.
Regla de trabajo: proponer y esperar el OK; confirmar antes de tocar canales reales.

## 1. Mercado Ripley (Mirakl, Perú) — esperando una cuenta con ventas

**Hecho y desplegado (solo lectura):** conectar con clave de API, importar ofertas por SKU, consultar pedidos cada 5 minutos y reflejar su estado (el usuario acepta y despacha en el portal de Ripley). Backend `21bfc91`, frontend `ec01b1b` (rama `feature/ojo-de-dios`, ya subido a SiteGround). Registro en Railway de cada consulta y de cada importación de historial, con el desglose por estado.

**Probado con datos reales (cuenta NodoShop de Nodo Shop):** conexión, 29 ofertas importadas (12 publicadas, 17 pausadas; 3 nuevas como borrador, 26 vinculadas por SKU). Historial de 90 días: 0 pedidos, y es real: esa cuenta no tiene ventas.

**Sin verificar:** convertir un pedido real en venta (cliente, envío, líneas, costos) y reflejar el cambio de estado (aceptado, enviado, recibido, cancelado, devuelto).

**Para retomar:** el usuario conecta una cuenta de Ripley que sí tenga ventas. Entonces: importar historial de 90 días, leer el log de Railway, revisar la lista de Ventas y confirmar el cambio de estado en la siguiente consulta de 5 minutos. Antes, comprobar que los SKU de esa cuenta estén en el catálogo de su tienda.

**Fases posteriores (solo con OK):** enviar stock y precio a Ripley (OF24 reemplaza la oferta completa; apagado tras `RIPLEY_PUSH_ENABLED`); publicar por CSV (OF01; hace falta bajar un CSV de ejemplo, preguntar antes); aceptar y despachar por API (OR21/23/24), solo si se necesita. Detalle en `docs/ripley-integracion.md`.

## 2. Roles de tienda — falta una prueba con una persona real

Fases 1, 2 y 3 hechas y subidas (servidor y frontend). Falta que el usuario cree un rol «Vendedor», se lo asigne a `josealrt1710@gmail.com` y compruebe qué ve y qué puede hacer. Detalle en `docs/roles-de-tienda.md`.

## 3. Actividad de usuarios (Superadmin › Actividad)

Las 4 fases están hechas (la Fase 4, descargas en Excel y PDF con «Personalizar…», ya estaba en el servidor y el frontend). Mapas de clics como zonas de calor en degradado, también en el PDF. Falta que el usuario suba el último paquete a SiteGround y pruebe las descargas con datos reales. Detalle en `docs/actividad-de-usuarios.md`.

## 4. Correos de avisos de venta (Brevo) — decisión del usuario

El plan gratuito de Brevo agotó su cuota, y por eso faltan correos. Opciones: subir de plan, o enviar un resumen de avisos de venta cada 15 minutos (menos correos). Sin decidir.

## 5. Limpieza manual de `ADMIN_EMAILS` en Railway

Quitar `josealrt1710@gmail.com` de la variable `ADMIN_EMAILS`. Lo hace el usuario en Railway; no se toca desde aquí.

## 6. Yavendió — en pausa

Ya funciona: conectar, publicar (incluidas variantes), precio y disponibilidad, e importar productos, pedidos históricos y contactos. Falta igualarlo a los otros canales: pedidos en vivo (consulta cada 5 minutos, stock, avisos, estados), precio propio por cuenta, edición de contenido, pausar y eliminar, refresco de estado y pantallas (publicar, carga masiva, filtro de ventas).
Plan: usar el mecanismo `channelHandlers` que usan WooCommerce, Shopify y Ripley (Fase A ventas en vivo, Fase B puntos 2 a 5, Fase C pantallas).
Preguntas sin responder: (1) ¿empezar por la Fase A? (2) ¿se pueden leer pedidos de la cuenta real de LaiHome y qué producto de prueba usar para escribir? (3) ¿consulta cada 5 minutos (recomendado) o webhook?
Detalle en `docs/yavendio-integracion-pendiente.md` (su sección 1 está desactualizada).

## 7. Carga masiva

Hecho: fases 1 y 2, salvo 2.4. Falta:
- 2.4: subida directa a almacenamiento. Espera que el usuario decida entre Cloudflare R2 y Cloudinary.
- Subida escalonada real en Railway (concurrencia 2 con 3 productos, luego 6 con unos 10 mirando la memoria, y un lote grande con `FALABELLA_BATCH_SIZE=200`).
- Fases 3 y 4 sin empezar: validación antes de publicar, revisión de fotos, categorías dudosas, tope por tienda, worker aparte, modelo de respaldo. Menores: tandas por tiempo.
Detalle en `docs/plan-carga-masiva.md`.

## 8. Variantes y SKU — orden acordado antes de Yavendió

Primero la base de variantes y el SKU generado, y después el resto de canales. Detalle en `docs/variantes-y-sku-plan.md`.

## 9. Tabla de tallas de calzado — para un cliente futuro

Cuando entre un cliente de zapatillas: tabla editable por grupo de variantes (US/EU/UK/cm), enviada a cada canal. Hace falta un producto real de calzado con su tabla actual.

## 10. Material suelto

`LEEME.md` de `synkro-siteground-release` está desactualizado (notas de un release anterior, sin Ripley).
