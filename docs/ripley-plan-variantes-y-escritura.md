# Ripley: plan para importar variantes y escribir en Ripley

> Estado: **plan, nada programado todavía.** Escrito el 2026-11-05 a partir de lo verificado con la cuenta real de Chumpi Bags.
> Complementa `docs/ripley-integracion.md` (que cubre la lectura, ya hecha). Regla de trabajo: cada fase que escriba en Ripley se
> pide y se aprueba por separado, y se prueba primero con **un solo SKU**.

## Punto de partida (verificado)

- Lectura de pedidos y ofertas funciona con datos reales; los estados, incluidos los 6 reembolsos reales, coinciden con el Excel de Mirakl.
- Cada oferta de Ripley llega como un producto suelto (`variationId: null`, sin grupo). Chumpi Bags tiene 266 ofertas.
- Enviar stock y precio a Ripley está apagado (`RIPLEY_PUSH_ENABLED`) y `RipleyApiService.setInventory()` lanza un aviso.
- Publicar productos nuevos no existe.
- Del Excel de pedidos: Mirakl guarda un «SKU del producto» con una base común y un sufijo por variante
  (`PMP20001695273-1` = bolso hueso, `PMP20001695273-5` = bolso negro), distinto del SKU de la oferta (`BOL0000024`, `BOL0000020`).
  Es la pista para agrupar, **sin confirmar** en la API.
- Ripley **acepta los pedidos solo**: en el Excel la «fecha de aceptación» es ~2 segundos después de la creación. Lo que hace la tienda es despachar.

## Orden recomendado

| # | Fase | Escribe en Ripley | Tamaño | Depende de |
|---|---|---|---|---|
| 0 | Reconocimiento de datos (solo lectura) | No | Pequeño | — |
| 1 | Importar con variantes agrupadas | No | Mediano | 0 |
| 2 | Enviar stock y precio a Ripley (OF24) | **Sí** | Mediano | — (puede ir en paralelo a 1) |
| 3 | Publicar productos nuevos por CSV (OF01), con y sin variantes | **Sí** | Grande | 0, 2 |
| 4 | Despachar pedidos desde Synkro (opcional) | **Sí** | Pequeño-mediano | — |
| 5 | Retoques: reembolso parcial y avisos | No | Pequeño | — |

La fase 2 es la más urgente para el negocio: hoy, si vendes algo en Falabella o Mercado Libre, el stock en Ripley no baja y se puede vender de más.

---

## Fase 0 — Reconocimiento (solo lectura)

**Objetivo:** saber qué dice realmente Ripley sobre variantes, categorías y atributos antes de programar nada.

1. Leer los datos de producto de ~10 ofertas de Chumpi Bags que sean de una misma familia (p. ej. los bolsos `PMP20001695273-*`):
   `GET /api/products/offers` (P11) y/o los datos de producto asociados a la oferta.
2. Comprobar: ¿viene el código de producto (`PMP…`)? ¿hay un campo de grupo de variantes (en Mirakl suele ser un atributo de la categoría)?
   ¿el sufijo `-N` coincide con la variante en las 266 ofertas?
3. Leer las categorías (`GET /api/hierarchies`, H11) y los atributos de las categorías de Chumpi Bags (`GET /api/products/attributes`, PM11,
   y `GET /api/values_lists`, VL11): cuáles son obligatorios y cuáles definen la variante (color, talla…).
4. Guardar el resultado en este documento (qué campo agrupa, qué atributos varían por categoría).

**Salida:** decisión escrita: «agrupar por X» o «agrupar a mano». **No cambia nada en Ripley ni en Synkro.**
**Permiso:** solo lectura con la clave ya conectada; la clave nunca pasa por el chat.

## Fase 1 — Importar con variantes agrupadas

**Objetivo:** que «Importar desde Ripley» cree familias de variantes (un producto con variantes) en vez de 266 productos sueltos.

Trabajo:
1. **Leer el grupo.** Extender `filaDeOfertaRipley` / `listListings` para traer el código de producto y, si existe, el grupo y los valores de
   variante (color, talla) de la fase 0. `ChannelListingRow` ya tiene `variationId` y `variation`.
2. **Agrupar.** Reutilizar `PlanDeGrupo` y `FalabellaVariantImportService` (`planearManual`, `aplicarManuales`, `aplicar`): hoy son de Falabella;
   se extrae lo común (agrupar por clave, elegir ejes, crear familia) a un servicio compartido y Ripley lo usa con su propia clave de grupo.
3. **Vista previa antes de importar**, como ya hace Falabella: familias detectadas, las que no se pudieron agrupar, y el botón «Agrupar» manual
   para corregir (ya existe `ManualVariantsDialog`; se conecta a Ripley). Con el flujo nuevo, importar y agrupar es **un solo paso**.
4. **Enlazar por SKU de oferta**: el SKU de la oferta (`BOL0000024`) sigue siendo la clave con la que se enlaza y con la que llegan las ventas
   (`offer_sku`), así que el stock por variante y las ventas siguen cuadrando.
5. **Si ya hay productos de Ripley importados sueltos** (Chumpi Bags aún no importó): proponer agruparlos sin duplicar, como en Falabella.

Pruebas: agrupar por la clave de la fase 0; una oferta sin grupo queda suelta; dos cuentas con los mismos SKU no se mezclan; la vista previa no escribe.
**Riesgo:** bajo; no escribe en Ripley. Orden de importación recomendado: Falabella y su agrupado primero, luego Ripley (se enlaza por SKU).

## Fase 2 — Enviar stock y precio a Ripley (OF24)

**Objetivo:** que el stock y el precio de Synkro lleguen a Ripley, y que una venta en otro canal baje el stock también allí.

**El peligro:** `POST /api/offers` **reemplaza la oferta entera**; lo que no se manda se borra. Por eso:
1. **Leer-modificar-escribir.** Antes de cada envío se lee la oferta actual (OF21 por SKU), se cambia solo `quantity` y/o `price` y se manda
   completa. Nunca se arma la oferta desde cero.
2. **Lotes.** Un envío con varias ofertas (Mirakl procesa en lote); se agrupan los cambios pendientes en una ventana corta para no saturar.
3. **Respuesta asíncrona.** OF24 devuelve un `import_id`; se consulta OF02 hasta que termine y, si hay líneas con error, OF03 (reporte de errores).
   El motivo del error se guarda en el enlace de la publicación y se ve en la app (como ya hacen WooCommerce/Shopify).
4. **Modo revisión** de cambios (ya existe `ChangeRequestsService`): al inicio, los cambios de precio pasan por aprobación; el stock va directo.
5. **Interruptor.** `RIPLEY_PUSH_ENABLED` sigue como freno de emergencia; se añade además un interruptor por cuenta.
6. **Descuentos.** Mirakl guarda el precio con descuento aparte (`discount`): se respeta lo que ya tenga la oferta y no se pisa.
7. **Conciliación.** Una revisión periódica compara el stock de Synkro con el de Ripley y avisa de las diferencias (no las corrige sola al principio).

**Piloto obligatorio (con tu permiso, en la tienda real):** un solo SKU de bajo riesgo. Se anota la oferta antes, se envía un cambio de stock,
se verifica con OF21 que **solo cambió el stock** y que el resto de la oferta quedó igual. Recién entonces se enciende para el resto.
Plan de vuelta: la oferta anotada antes del piloto permite restaurarla.

Pruebas: la oferta se manda completa; un error de Ripley no rompe el resto del lote; un reintento no duplica; con el interruptor apagado no sale nada.

## Fase 3 — Publicar productos nuevos por CSV (OF01)

**Objetivo:** crear productos y ofertas en Ripley desde Synkro («IA Productos» ya muestra Ripley como destino), con y sin variantes.

Previo: **necesito tu permiso para bajar el CSV de ejemplo y la imagen de reglas** que enlaza la documentación (están en el S3 de Ripley).

Trabajo:
1. **Categoría.** Mapear la categoría del producto a una de Ripley (H11). Propuesta con IA y confirmación tuya; se guarda para reutilizarla.
2. **Atributos.** Leer los obligatorios de esa categoría (PM11/VL11) y rellenarlos con la IA a partir del producto; lo que falte se pide en un formulario.
3. **Imágenes.** Ripley pide las fotos por enlace público: se usan las del producto (Cloudinary/R2) y se validan tamaño y formato según las reglas.
4. **Variantes.** Cada variante es una fila del CSV con el **mismo código de grupo** y sus valores de color/talla; el SKU de la oferta es el de Synkro.
5. **Generar y subir el CSV** (`POST /api/offers/imports`, `with_products=true`); guardar `import_id` y `product_import_id`.
6. **Seguimiento.** Consultar P42/OF02 y mostrar los errores de transformación (P47) y de oferta (OF03) en la app, en lenguaje claro, con qué fila falló.
7. **Reintentos y correcciones**: corregir en Synkro y volver a enviar sin duplicar.

Pilotos: primero **un producto sin variantes**, luego **una familia pequeña con variantes**. Ripley valida y puede tardar (la carga de productos
pasa por revisión de catálogo): la app muestra el estado hasta que quede publicado.
**Riesgo:** el más alto del plan (catálogo real de la tienda). Por eso va al final y por pasos.

## Fase 4 — Despachar pedidos desde Synkro (opcional)

Ripley acepta solo; la tienda despacha desde el portal. Si te interesa hacerlo desde Synkro: marcar el pedido como enviado con su seguimiento
(`OR24`, y `OR23` para el seguimiento), usando el transportista y el código que ya se leen. Decisión tuya: solo vale la pena si despachar en el
portal te quita tiempo. Si no, se omite.

## Fase 5 — Retoques

- **Reembolso parcial** (pedido con varias líneas y solo una reembolsada): hoy cuenta como «Entregado» por el total. Reflejar el importe reembolsado
  y no contarlo en los totales. No ha ocurrido en tus datos, por eso es de baja prioridad.
- **Historial de más de 6 meses**: si algún día hace falta.

## Decisiones que necesito de ti

1. ¿Autorizas la **fase 0** (leer datos de producto, categorías y atributos con la clave ya conectada)?
2. ¿Empiezo por la **fase 1 (variantes)** o por la **fase 2 (stock y precio)**? Mi recomendación: la 2 primero por el riesgo de vender de más, y la 0 en paralelo.
3. Para la fase 2: ¿qué **SKU** usamos de piloto (uno con poco movimiento)?
4. Para la fase 3: ¿autorizas bajar el CSV de ejemplo y la imagen de reglas?
5. ¿Despachas desde el portal de Ripley y te sirve así (fase 4 omitida)?
