# Integración de productos con Yavendio — análisis y plan pendiente

Estado: **pendiente**. Se construye después de definir y construir las variantes (ver `docs/variantes-plan.md` cuando exista).
Fuente: documentación pública `https://docs.ya.works` (API Business v1.15.0, último cambio del changelog: 2026-10-13) y capturas del panel de Yavendio de la cuenta LaiHome. Revisar el changelog antes de construir: la API cambia seguido.

## 1. Qué es Yavendio y qué permite la API

Canal de **venta directa por WhatsApp** (sin comisión de canal). Base `https://api.ya.onl/v1`, autenticación con el header `X-API-Key` (`yv_live_v1_...`). Las keys se crean en el panel (Configuración → Claves API). **No hay sandbox**: toda key opera sobre datos reales.

| Área | Operaciones |
|---|---|
| Productos | listar, crear, leer, editar, eliminar |
| Opciones y valores | CRUD (ejes: Talla, Color, Personaje…) |
| Variantes | CRUD: `sku` (opcional), `base_price`, `currency`, `status` |
| Media | CRUD de imágenes **por variante**, por URL |
| Categorías | etiquetas globales; se asignan con `tag_ids` |
| Catálogos | solo lectura (uno por comercio) |
| Pedidos | listar, leer, contar por estado, **crear** (ventas fuera de WhatsApp) |
| Webhooks | `order.created`, `order.status_changed`; firma Svix; máx. 20 por comercio; timeout 30 s; entrega no exactamente-una-vez (receptor idempotente) |
| Conversaciones, contactos, empresa | solo lectura |
| Plantillas WhatsApp | listar y enviar con plantilla aprobada (`event_id` idempotente; `402` si no hay saldo) |

Hoy Synkro solo **lee** de Yavendio (empresa, conversaciones, pedidos, contactos) para el CRM (`src/sync/yavendio/yavendio-api.service.ts`, `src/crm/yavendio-import.service.ts`). No crea productos, no sincroniza precio ni disponibilidad, no usa webhooks.

## 2. Restricciones que condicionan el diseño

- **Modelo obligatorio:** producto → opciones → variantes → media / categorías. Todo producto, incluso uno simple, necesita **al menos 1 opción y 1 variante** (ej. opción "Presentación", valor "Estándar"). Las opciones deben existir antes que las variantes (`option_values` obligatorio, mínimo 1 id).
- **`option_values` es inmutable** tras crear la variante: para corregirlo se borra y se crea de nuevo.
- **No hay endpoints por lote.** Cada entidad es una llamada. Respetar `X-RateLimit-*` y `Retry-After` (los valores no están documentados; el ejemplo muestra 1/s). Encolar con espera.
- **Textos:** nombre ≤ 250, descripción ≤ **500** (texto simple, no HTML), `characteristics` opcional. Estado de producto al crear/editar: solo `published` (las respuestas pueden traer `unpublished`).
- **Moneda:** debe coincidir con la del catálogo (PEN en el caso de LaiHome; se lee de `GET /company`).
- **Fotos por variante**, por URL https.
- **Sin atributos de categoría, marca, medidas ni control de calidad:** no se necesita la IA de atributos.
- **Fechas** en la zona horaria del comercio (header `X-Timezone`, ISO 8601 con offset).

## 3. SKU: Yavendio no lo usa como identificador

- `sku` en la variante es **opcional** y la documentación no dice que sea único. No hay búsqueda por SKU (el listado solo admite `page` y `limit`). En el panel del comercio no se muestra.
- **Mapeo interno = fuente de verdad.** Cada vínculo guarda, por cuenta: producto Synkro (con su SKU) ↔ `product_id` + `variant_id` de Yavendio. Se usa el enlace del canal (`ListingLink`: id externo + `variationId`, como Mercado Libre).
  - Una variante de Yavendio ↔ un producto de Synkro por cuenta (y al revés). Si se repite, se rechaza.
  - Si el `variant_id` deja de existir (404), el vínculo queda **roto** y aparece en "por vincular de nuevo".
  - Los pedidos se asocian por `variant_id` primero, y por `sku` solo como respaldo. Si no hay coincidencia, el pedido se guarda igual con la nota "producto no vinculado".
- **Escribir el SKU en Yavendio es opcional** y se verifica antes de confiar: escribir en una variante, volver a leer el producto y comprobar que `variants[].sku` lo devuelve. Si no vuelve, se desactiva para esa cuenta. Por defecto **apagado** hasta comprobarlo. Solo rellena SKU vacíos; si hay uno distinto, va a una lista de diferencias.

## 4. Stock

- La **API no tiene campo de stock** (en v1.15.0). El panel sí lo muestra por variante: interruptor "Stock (opcional)"; apagado = "Ilimitado". Lo único en la API: `status` de la variante, `available` / `not_available` ("Available means the variant has stock").
- Decisión: **Synkro es la fuente de verdad**. Las variantes se dejan en **"Ilimitado"** en Yavendio y Synkro controla la disponibilidad por `status`: `available` si hay stock, `not_available` al llegar a 0. No mezclar stock numérico en Yavendio con el de Synkro en el mismo producto (dos números sin forma de comparar).
- Sin stock de seguridad (se descartó: confunde al usuario).
- **Venta mayor que el stock** (ej. stock 1, pedido de 3): el stock baja a 0 (hoy el código lo limita a 0 y pierde la diferencia en silencio). Mejorar: **aviso** "Pedido #N de Yavendio: 3 unidades de X, había 1. Faltan 2"; variante a `not_available`; propagar 0 a los demás canales; **reponer** el stock si el pedido pasa a `cancelled`/`rejected` (evento `order.status_changed`). Synkro no puede cancelar el pedido (la API no cambia estados de pedido).
- Hay una ventana de riesgo de segundos/minutos entre el pedido y el cambio de estado; no se elimina.
- **Pedir a Yavendio** que exponga el stock en la API v1 (crear/editar variante y leerlo) y que aclare si el stock del panel se descuenta solo y marca "No disponible" al llegar a 0. Texto sugerido para soporte: ver `docs/` o el historial de la conversación.
- Productos **importados de Yavendio** entran con el stock **"sin definir"** y Synkro **no toca su disponibilidad** hasta que el usuario lo defina (si no, la primera sincronización vería 0 y cortaría las ventas). Hay que soportar el estado "sin definir" (hoy `stock` es entero con 0 por defecto).

## 5. Precios por canal (diseño acordado)

Venta directa sin comisión → el precio suele ser distinto al de marketplaces.

- **Precio general** = el `price` actual del producto. **Por defecto todo canal usa el general.**
- **Precio propio por canal/cuenta:** tabla nueva `producto + cuenta → precio` (no en el enlace del canal, porque el enlace solo existe tras publicar y se quiere fijar antes). Precio efectivo = propio si existe, si no el general; todos los envíos (publicar, actualizar, pedidos) usan una sola función.
- UI: campo "Precio general" + "Usar el mismo precio en todos los canales" (se deduce: marcado si ningún canal tiene precio propio) + por canal "Usar el general" / precio propio, con la diferencia en %. Mockup aprobado.
- Cambiar el general actualiza solo los canales que lo siguen; se informa cuántos conservan precio propio.
- Descuento con fechas de Falabella: se valida contra el precio efectivo de esa cuenta.
- Al vincular un producto existente de Yavendio, **su precio actual queda como precio propio** de ese canal, sin sobrescribirlo.
- Excel de carga masiva: `precio` (general) + una columna por canal conectado (ej. `precio_yavendio`); vacío = general.
- El "precio web" actual (`webPrice`) pasaría a ser el precio propio del canal web (WooCommerce) cuando se conecte.
- **Pendiente de decidir:** precio propio por cuenta (recomendado, con atajo "aplicar a todas las cuentas de Falabella") o por tipo de canal.

## 6. Importar y vincular productos que ya existen en Yavendio

Mismo flujo que Falabella/Mercado Libre (vista previa sin escribir, luego importar), adaptado a que muchas variantes **no traen SKU**:

| Caso | Acción |
|---|---|
| Trae SKU y ya está en Synkro | vincular |
| Trae SKU y no está en Synkro | crear el producto con ese SKU y vincular |
| No trae SKU | sugerir coincidencia con un producto existente, o crear uno con SKU generado |

- **Asistente de coincidencias** (nunca vincula solo; un vínculo equivocado hace que Synkro cambie precio/disponibilidad del producto que no corresponde): por cada variante de Yavendio, hasta 3 candidatos con puntaje. Señales: SKU exacto (decisiva), nombre (palabras + vectores), imágenes (huella visual, sin IA), precio, descripción, nombre de la variante (color/talla). Alto (~85 %+ con un solo candidato): preseleccionado, espera "Vincular"; medio (60–85 %): elegir; bajo: crear/vincular a mano/ignorar. Dos candidatos parecidos no se preseleccionan.
- Respaldo para volumen: Excel de vinculación (Synkro exporta variantes de Yavendio con una columna "SKU de Synkro" para completar y subir).
- Productos nuevos desde Yavendio: nombre, descripción, precio (queda como precio propio de ese canal), fotos **vueltas a subir** a nuestro almacenamiento. Mientras no existan grupos de variantes, cada variante = un producto "producto - variante" (como la importación de Mercado Libre); con grupos se reúnen usando el producto padre.
- SKU para variantes sin SKU: **pendiente de decidir** (recomendado: prefijo con numeración, `YV-0001`…; alternativa derivado del nombre). Visible y editable en la vista previa.
- Primera sincronización: no pisar nada sin avisar; mostrar diferencias de precio.
- Deshacer un vínculo sin tocar los productos.

## 7. Pedidos y avisos

- Webhooks `order.created` y `order.status_changed` (registrar automáticamente como con Falabella, guardar el `secret`, verificar firma Svix, idempotencia por `Svix-Id`), más consulta periódica de respaldo.
- Pedido puede llegar **sin dirección** (`address: null`) y **sin líneas** (`items: []`, las gana después con el mismo `id`): releer antes de darlo por cerrado. `payment_terms: paid_pending_review` = tratar como no pagado.
- Los pedidos entran con el precio real de cada línea (`base_price`); comisión de canal 0 en reportes.
- Estados: `pending, confirmed, preparing, ready_for_dispatch, dispatched, delivered, completed, rejected, cancelled`.

## 8. Orden de construcción

0. Base de variantes en Synkro (modelo, Tablero, Ficha, creación) — **antes** de esto.
1. Yavendio: publicar y sincronizar con variantes nativas (el modelo de Yavendio coincide con el de variantes propuesto), precios por canal, importación agrupada, pedidos con aviso de faltante.
2. Falabella con variantes (una ficha por variante, mismo `ParentSku`).
3. Mercado Libre con variaciones (una publicación; ejes permitidos por categoría).

## 9. Decisiones abiertas

1. Precio propio por cuenta o por tipo de canal.
2. Formato del SKU generado para variantes sin SKU.
3. Confirmar el stock "sin definir" al importar (recomendado) o preguntar durante la importación.
4. Escritura del SKU en Yavendio: dejar apagada hasta verificarla (recomendado).
5. Respuestas de soporte de Yavendio: ¿SKU único?, ¿stock en la API?, ¿límites de peticiones?
