# Variantes y SKU — decisiones y plan (fase 0)

Estado: **diseño acordado, sin construir**. Orden de trabajo: primero esto (base de variantes), luego Yavendio (`docs/yavendio-integracion-pendiente.md`), luego Falabella con variantes y Mercado Libre con variaciones.

## 1. Modelo de variantes

- **Grupo** (producto padre): nombre, descripción, categoría, marca y fotos comunes. No se vende.
- **Ejes** libres por grupo: Color, Talla, Personaje, Largo, Material… (o uno que escriba el usuario). Cada eje tiene sus valores.
- **Variante**: una por combinación. Tiene su SKU único, precio, stock y fotos. Sigue siendo un producto (fila en `products`) con un `parentId` hacia el grupo, para que stock, ventas, precio y Ficha sigan funcionando por SKU.
- Todo producto actual pasa a ser un grupo de una sola variante: sin cambios visibles ni migración de datos.
- El precio por canal se diseña sobre la variante (ver `yavendio-integracion-pendiente.md` §5).

### Por canal
- **Falabella:** una ficha por variante, mismo `ParentSku`; `Variation` único dentro del grupo (hoy se rellena con el SKU). Eje personalizado: va en el nombre de la variación.
- **Mercado Libre:** una publicación con variaciones (precio, stock y fotos por variación). Solo admite los ejes que la categoría permite; si no se permite (ej. "Personaje"): decidir entre publicaciones separadas o atributo (abierto).
- **Yavendio:** modelo nativo (producto → opciones → valores → variantes → fotos por variante); todo producto necesita ≥ 1 opción y 1 variante.

### Qué puede romperse (revisar al construir)
Tablero (una tarjeta por producto hoy → grupo plegable), formulario y Excel de carga masiva (una fila = un producto), cola de IA (analizar el grupo una vez, no por variante), `fotosDeCarpeta` (un SKU de grupo es prefijo de los de sus variantes), Mercado Libre (una publicación ↔ muchos productos; ya hay `variationId` en el enlace), Ficha y `scheduleContentSync` (propagar cambios del grupo a todas las fichas), unicidad del SKU, reportes que cuentan "productos".

## 2. Crear un producto con variantes (misma pantalla, paso a paso)

Un solo flujo, sin otro formulario. Cada respuesta despliega el siguiente paso; si se cambia una respuesta anterior, los pasos de abajo se reinician.

1. Fotos (todas juntas), SKU opcional, precio, stock — como hoy.
2. **¿Tiene variantes?** No → un solo producto. Sí → continúa.
3. **¿En qué se diferencian?** Etiquetas de ejes (Color, Talla, Personaje, Largo, Material, otro). Cada eje elegido muestra sus valores sugeridos para tocar y un campo para otro valor.
4. **¿Las fotos cambian?** No / Sí según [eje]. (Asignación de fotos por valor del eje: pantalla por diseñar, la parte más delicada.)
5. **¿El precio es el mismo?** Sí / No, varía según [eje] → una casilla por valor de ese eje (no una por variante).
6. **¿Y el stock?** El mismo para todas / lo indico por variante.
7. **Revisa tus N variantes:** tabla con solo las columnas que varían; SKU editable solo mientras se crea.
8. Generar con IA: una sola pasada para el grupo (fotos y descripción comunes; título y atributos por variante).

Después: "Agregar variante" en la Ficha del grupo (misma lógica). Excel masivo: una fila por variante con `sku_padre` y columnas de ejes (por diseñar).

## 3. SKU generado

**El SKU es opcional al crear.** Lo escrito por el cliente se respeta tal cual, sin paso extra de confirmación.

- **Cliente sin SKU:** `PREFIJO-NNNN` (prefijo = iniciales de la tienda, editable en su configuración; contador por tienda con incremento transaccional; salta números ocupados). Variantes: código del grupo + valores (`KI-0013-ROJO-M`).
- **Cliente con SKU:** Synkro analiza el formato del **último bloque de productos publicados** de la tienda (propuesta: los últimos 20) y genera el siguiente: patrón dominante; en empate, el del más reciente; respeta el relleno de ceros y salta los ocupados. Ejemplo visto en la tienda Kassari (formatos mezclados): `C0155`, `C0250`, `CO126`, `BL000032`, `VAJ-ARI-S4`.
- **No editable** una vez creado (pantalla y API). Para corregir: eliminar y crear de nuevo, o duplicar con otro SKU. La edición masiva por Excel usa el SKU solo como llave de búsqueda.
- **Carga masiva:** filas sin SKU no se rechazan: se crean con la información recopilada (fotos, nombre/descripción por IA, precio, stock) y reciben SKU con esta lógica. Al terminar, Excel descargable con los SKU asignados (fila → SKU).
- **Posibles duplicados sin SKU** (mismas fotos que otra fila o que un producto existente): **pendiente de decidir** si bloquean la fila hasta confirmar o si se crea y solo se avisa.
- **Caracteres del SKU generado:** mayúsculas, números y guion, hasta ~30 caracteres. Verificar los límites exactos de Falabella (SellerSku) y Mercado Libre antes de construir; los SKU escritos a mano se respetan pero se validan contra esos límites.
- Importación desde canales: productos sin SKU reciben uno con esta lógica y se escribe en el canal solo si lo permite (Mercado Libre sí; Falabella no deja cambiar el SellerSku).

### Unicidad
- El SKU **no es la clave primaria** (la clave es un `uuid`); se garantiza con una restricción única.
- Hoy: único `(sku, owner)`, exacto; la normalización (mayúsculas/espacios) solo en código (`assertSkuLibre`) → una carga concurrente podría duplicar.
- **Propuesta:** unicidad en la base de datos, sin distinguir mayúsculas ni espacios, **por tienda** (no global: dos clientes pueden usar `C0001`; no por cuenta: la cuenta del agencia tiene varias tiendas de clientes). Antes de migrar: revisar duplicados dentro de cada tienda y qué hacer con productos antiguos sin tienda.

## 4. Decisiones abiertas

1. Fotos: ¿cambian casi siempre con el color, a veces con otro eje, o son iguales para todo?
2. Precio: ¿varía normalmente por talla (KING/QUEEN)? Si sí, "precio por eje" en lugar de fila por fila (ya incluido en el flujo).
3. Cantidad típica de variantes por grupo (si pasan de 20–30, replantear tabla y Excel).
4. Mercado Libre: eje no permitido → ¿publicaciones separadas o atributo?
5. SKU: confirmar alcance de unicidad por tienda, tamaño del "último bloque" (20) y qué hacer con posibles duplicados sin SKU en cargas masivas.

## 5. Actualización (2026-10-21): detalle de la creación con variantes

### 5.1 Valores personalizados
Cada campo "Otro…" (eje nuevo o valor nuevo dentro de un eje) lleva un círculo con check al lado: apagado (gris) mientras el campo está vacío; en cuanto hay texto se pone verde y al tocarlo agrega el valor. Enter sigue funcionando.

### 5.2 Precio que depende de uno o dos ejes
En el paso del precio las opciones de ejes son casillas combinables ("Varía según color", "Varía según talla").
- Ninguna: todas usan el precio de arriba.
- Un eje: una casilla de precio por valor.
- **Dos ejes: cuadrícula** con un precio por cada combinación (filas = un eje, columnas = el otro), con el precio base como valor inicial en todas las celdas. No se suma "base + extra por color + extra por talla": los precios no suelen ser aditivos.
- Tres ejes o más: el precio de cada variante se escribe en la tabla final.

### 5.3 Fotos por variante (paso nuevo, solo si hay variantes)
Va después de definir las variantes y de subir todas las fotos juntas.
1. Se marcan una, varias o todas las variantes (casillas, con atajos: "Todas", "Todas las rojas", "Talla M"…). Lo que se toque se aplica a las marcadas.
2. Se tocan las fotos **en el orden en que se quieren mostrar**: cada una muestra su número al instante; la primera es la **Principal**. Una foto que solo tienen algunas de las marcadas muestra "~"; cada foto indica en cuántas variantes se usa.
3. **Una sola foto para todas** = atajo "Todas" y tocar la foto. Por lotes = marcar un grupo (por color, por talla o a mano).
4. **Regla acordada (opción A):** si todas las marcadas ya tienen la foto, tocarla la quita de todas; si no, se agrega al final de las que no la tienen.
5. Máximo 8 fotos por variante (tope de Falabella). "Quitar las fotos de las marcadas" limpia solo esas variantes.
6. **"Asignar con IA"**: propone por color y deja las fotos neutras (tabla de tallas) como comunes a todas; siempre es una propuesta que el usuario revisa.
7. Resumen final por variante: orden de sus fotos y principal; las variantes sin fotos se marcan antes de generar.
8. Carga masiva: en el ZIP, una carpeta por color dentro de la del producto (`MK-1/rojo/1.jpg`) hace la asignación sola.

### 5.4 Detector de variantes (filtro previo con IA)
- **Cuándo:** al pulsar "Generar con IA", antes de crear como producto individual.
- **Qué mira:** fotos (el mismo producto en varios colores/versiones, muestras de color, tablas de tallas), texto ("disponible en tallas…", "en colores…", medidas alternativas) y, en masivo, nombres de archivo.
- **Qué entrega:** si parece tener variantes, con evidencia concreta (qué fotos, qué frase) y una propuesta lista (ejes, valores, fotos por color). Botones: "Sí, crear con variantes" (entra al recorrido rellenado) o "No, es un solo producto" (no vuelve a preguntar por ese producto).
- **Sin señales concretas no pregunta nada.** Debe distinguir "mismo producto en varios colores" de un producto con varios colores en su diseño y de un set de piezas distintas; la decisión es del usuario. Se puede apagar por tienda.
- **Costo:** no es una consulta aparte: se extiende la lectura de fotos de `ProductVisionService.analyze` (esquema con `variantes`: ejes, valores, evidencia, etiqueta de color por foto) y su resultado se pasa a `generateProductContent` para no repetirla.
- **Carga masiva:** no frena el lote; las filas con posibles variantes se crean como productos individuales y quedan marcadas en el resultado ("posibles variantes: rojo y azul, sugiero agruparlas con `sku_padre`").
- **Calibración:** antes de activarlo, probar con ~10 productos con variantes y ~10 sin ellas del usuario para medir falsos positivos/negativos y ajustar el umbral.

Mockups aprobados en la conversación: recorrido paso a paso (valores personalizados con check, precio por uno o dos ejes), asignación de fotos con orden y lotes, y la tarjeta del detector.

## 6. Actualización: orden del flujo, SKU automático, variantes por canal e importación

### 6.1 Orden del flujo (decidido)
1. El usuario sube fotos (y, si quiere, texto, precio y stock). Se identifican las variantes (detector de IA o el usuario).
2. **Los SKU se generan solos en ese momento** (grupo y variantes), con el formato de la tienda.
3. La IA llena todos los datos (una sola pasada para el grupo).
4. **Recién entonces** se le indica al usuario que puede **revisar y editar todo lo que identificó la IA**: variantes (incluso agregar o quitar), SKU, fotos por variante (orden y lotes), precios (incluido por uno o dos ejes) y stock.
5. Luego se publica.
Esto desplaza al paso posterior a la IA lo que hoy se pide antes (fotos por variante, precio por ejes, stock): antes de crear solo se confirman ejes y valores; fotos, precio y stock arrancan con valores propuestos (fotos por el detector, precio y stock de los campos del formulario).

### 6.2 SKU (implementado)
- Opcional al crear (producto simple, grupo y filas del Excel masivo). Si falta se genera: formato dominante del último bloque (20) de productos publicados de la tienda, con el número siguiente al mayor usado y el mismo relleno de ceros; sin productos, `INICIALES-0001`. Variantes: código del grupo + valores (`KI-0013-ROJO-M`).
- **Regla actualizada:** el SKU se puede corregir mientras el producto **no se haya intentado publicar** en ningún canal; desde el primer intento de publicación ya no cambia.
- Endpoint informativo: `GET /products/sku/next`.
- Pendiente: Excel descargable con los SKU asignados en la carga masiva (hoy la respuesta trae `skusGenerados`) y aviso de posibles duplicados en filas sin SKU.

### 6.3 Publicar variantes por canal (por investigar y construir)
- **Falabella:** solo se agrupan fichas (mismo `ParentSku`, `Variation` distinto) si la **categoría elegida coincide con el producto Y admite variantes**. Si no hay una categoría que cumpla ambas cosas, **cada variante se publica como producto independiente** (sin agrupar, nombre con su combinación). Lo más probable es que Falabella solo admita variación por talla y color: **hay que comprobarlo con los atributos reales de las categorías** (`GetCategoryAttributes`; ver qué marca una categoría como apta para variantes). Un grupo de Synkro con más ejes de los que admite el canal publica solo los que el canal admite y el resto se separa en fichas independientes.
- **Mercado Libre:** una publicación con `variations`; los ejes deben ser atributos de la categoría marcados como aptos para variación (etiquetas `allow_variations`/`variation_attribute` de `GET /categories/{id}/attributes`). Una característica personalizada ("Personaje") solo sirve si la categoría la ofrece como atributo de variación; si no, publicaciones separadas o atributo del producto. **Por verificar contra la API real**, igual que si se pueden agregar variaciones a una publicación existente.
- **Yavendio:** opciones y valores de nombre libre (confirmado en su documentación): admite cualquier eje.

### 6.4 Importar con la estructura de variantes de cada canal
Objetivo: al importar, Synkro crea el grupo con los mismos ejes y variantes que tiene el canal.
- **Mercado Libre:** `variations[].attribute_combinations` da los ejes (nombre y valor) y cada variación su id, precio, stock y fotos (`picture_ids`); la importación actual ya crea un producto por variación y guarda `variationId`; falta reunirlos en un grupo con esos ejes.
- **Yavendio:** producto → `options` (ejes y valores) → `variants` (con `option_values`) → media por variante: se importa tal cual.
- **Falabella:** no hay estructura explícita: se agrupan las fichas con el mismo `ParentSku` y los ejes se deducen de los atributos que difieren entre las fichas hermanas (Color, Talla…); si no se pueden deducir, un eje "Variante" con el texto de `Variation`.
- Cada vínculo conserva el id del canal (producto y variante) para sincronizar precio, stock y pedidos por variante.
