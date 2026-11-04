# Integración con Mercado Ripley

> Estado: **fases 1 a 3 programadas y probadas (solo lectura)**, sin subir todavía. Falta que el dueño conecte su clave en la app para verificar contra la tienda real. Stock/precio hacia Ripley apagado (`RIPLEY_PUSH_ENABLED`).

## Qué es Mercado Ripley técnicamente

Mercado Ripley funciona sobre **Mirakl** (la plataforma de marketplaces), no sobre una API propia. La documentación que se encontró
(<https://documenter.getpostman.com/view/206599/api-mercado-ripley/6n4UtAt>) es la oficial de Ripley para vendedores y **es la correcta**,
pero es corta (15 llamadas) y de 2017: sus ejemplos son de Chile (CLP, `ripley-prod.mirakl.net`).

* **Dirección base:** `https://ripley-prod.mirakl.net` (la de Chile; **la de Perú hay que confirmarla**, ver preguntas).
* **Autenticación:** una **API key por tienda (seller)**, que se saca entrando al portal y pulsando el correo arriba a la derecha.
  Va en la cabecera `Authorization: <clave>` (sin «Bearer»). No hay OAuth ni caducidad conocida: la clave es como una contraseña.
* **Formato:** JSON; los fechas, `yyyy-MM-dd'T'HH:mm:ss`. Sin webhooks: las ventas se **consultan** (polling).
* La colección se puede bajar sin cuenta: `https://documenter.gw.postman.com/api/collections/206599/6n4UtAt?segregateAuth=true&versionTag=latest`.

## Lo que cubre la documentación

| Para qué | Llamada | Notas |
|---|---|---|
| Comprobar la clave y ver la tienda | `GET /api/account` (A01) | nombre, id de la tienda, correo |
| Ver las ofertas de la tienda | `GET /api/offers` (OF21) | `sku`, `paginate=true&max=&offset=`; por defecto solo 10 |
| Cambiar precio y stock | `POST /api/offers` (OF24) | JSON; devuelve `import_id` (asíncrono) |
| Ver cómo salió una importación | `GET /api/offers/imports/{id}` (OF02), `…/error_report` (OF03) | `lines_in_error` |
| Crear productos + ofertas | `POST /api/offers/imports` (OF01) | **CSV** UTF-8, `with_products=true`; devuelve `import_id` y `product_import_id` |
| Estado de la carga de productos | `GET /api/products/imports/{id}` (P42), `…/transformation_error_report` (P47) | |
| Categorías, atributos y valores | `GET /api/hierarchies` (H11), `/api/products/attributes` (PM11), `/api/values_lists` (VL11) | cada categoría tiene sus atributos obligatorios |
| Ver los pedidos | `GET /api/orders` (OR11) | `start_update_date`, `end_update_date`, `paginate`; trae cliente, líneas, comisión, estados |
| Mensajes de un pedido | `GET/POST /api/orders/{id}/messages` (OR41/OR42) | |
| Ofertas de un producto | `GET /api/products/offers?product_ids=` (P11) | |

**Cuidado con OF24:** en Mirakl actualizar una oferta **reemplaza la oferta entera**; lo que no se manda se borra. Hay que leer la oferta
(OF21) y mandarla completa con el precio o el stock nuevo.

## Lo que NO cubre (y Synkro necesitaría, según cómo opere Ripley)

* **Aceptar, rechazar y despachar pedidos** (en Mirakl: OR21, OR23, OR24). La documentación no los trae. Si Ripley exige hacerlo por API
  (y no solo desde su portal), hay que pedirle a Ripley la documentación completa o usar la estándar de Mirakl
  (<https://developer.mirakl.com/content/product/mmp>).
* **El formato exacto del CSV de carga:** está en un archivo de ejemplo y en una imagen enlazados desde la documentación (S3 de Ripley).
  Hace falta solo para publicar productos nuevos (fase 5).
* Fotos de los productos en las ofertas: la lista de ofertas trae título, SKU, precio y stock; las fotos van en la carga de productos.

## Plan (mismo molde que Falabella, Shopify y Yavendió)

Todo cuelga de `MarketplaceConnection` con `marketplace = 'ripley'`, credenciales cifradas (`CredentialsEncryptionService`), hasta 3 cuentas
por tienda y los permisos de tienda de siempre (`canales.conectar`, `canales.publicar`, `ventas.registrar`…).

1. **Conexión.** Pantalla para pegar la API key (y la dirección si Perú es otra); se valida con A01 y se guarda cifrada. Ruta
   `POST /sync/ripley/connect` (permiso `canales.conectar`). *Solo lectura: no toca nada en Ripley.*
2. **Importar las ofertas que ya tiene la tienda** (OF21 paginado) y enlazarlas por SKU con los productos de Synkro, como en los demás canales.
3. **Ventas.** Consultar OR11 cada pocos minutos con `start_update_date`, guardar cada pedido en `marketplace_orders` (cliente, líneas, comisión,
   envío), traducir los estados de Mirakl al estado común (pendiente / enviado / entregado / cancelado / devuelto), descontar stock y avisar
   (aviso por correo y notificación). Idempotente, como el resto.
4. **Stock y precio hacia Ripley** (OF24 completo + comprobar con OF02), usando el modo revisión que ya existe.
5. **Publicar productos nuevos** (OF01 con CSV): mapear categoría (H11) y atributos (PM11/VL11) con la IA, generar el CSV, subirlo y leer los
   reportes de errores. Es la parte más grande: va al final.
6. **Acciones de pedido** (aceptar, despachar) solo si Ripley las exige por API.

Las fases 1 a 3 son de solo lectura y se pueden probar contra la tienda real sin riesgo.

## Preguntas abiertas (para el dueño)

1. ¿Con qué dirección entras al portal de vendedor de Ripley, y es la de Perú o la de Chile?
2. ¿Ya tienes la API key? (La sacas tú desde el portal; nunca se la pegues a nadie por chat.)
3. ¿Ripley te exige aceptar y despachar los pedidos, y lo haces por el portal o por API?
4. ¿Empezamos por las fases 1 a 3 (conectar, importar ofertas y ver ventas), todo de solo lectura?
5. ¿Autorizas bajar el CSV de ejemplo y la imagen de reglas de la documentación (solo hace falta para la fase 5)?

## Lo que ya está hecho (fases 1 a 3)

- Conectar: `POST /sync/ripley/connect` (permiso `canales.conectar`); la clave se valida con GET /api/account, se guarda cifrada y la dirección (solo `*.mirakl.net`, por defecto Perú) en `secrets.site`.
- Ofertas: importación por SKU con el mismo flujo de WooCommerce/Shopify (OF21, hasta 5.000).
- Pedidos: consulta cada 5 min (OR11) más historial; el estado de Mirakl se traduce al estado común y, si la venta ya existe, solo se actualiza su estado/seguimiento (no duplica ni toca el stock). Aceptar y despachar se hace en el portal de Ripley.
- Apagado a propósito: enviar stock y precio a Ripley (POST /api/offers reemplaza la oferta entera). Se enciende con `RIPLEY_PUSH_ENABLED=true` tras probar con la tienda real.
- Pruebas: `ripley-mapping.spec.ts`, `ripley-api.service.spec.ts` y los casos Ripley de `ecommerce-sync.spec.ts`.
