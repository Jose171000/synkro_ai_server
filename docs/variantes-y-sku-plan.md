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
