# Plan: carga masiva rápida, estable y que llegue a 1000 productos

Escrito el 2026-10-28 a partir de la carga real de 32 filas de Kassari Import (29 productos creados). Actualizado el 2026-10-29 con las comprobaciones de código, de Railway y de los límites de DeepSeek y OpenAI.

## 1. Qué medimos y comprobamos

| Dato | Valor | De dónde sale |
|---|---|---|
| Productos creados | 29 de 29, 0 fallidos al final | logs del lote `59e87414` |
| Tiempo de la IA por producto | ~17 s (de 8 a 27 s) | logs de `AiProcessor` |
| Tiempo total de la IA del lote | ~9 min | idem |
| Cola de IA | `@Processor('generate-listings-queue')` sin `concurrency`: **1 a la vez** | `ai.processor.ts` |
| Otras colas | `product-edit` 10, `category-seed` 5, `category-edit` 5 | `*.processor.ts` |
| Llamadas de IA por producto | ~9 seguidas | `ai.service.ts` |
| Respuesta del botón «Generar con IA» | varios minutos: el servidor recibe el zip en memoria (`AdmZip(zipFile.buffer)`) y sube **todas las fotos** antes de responder | `bulk-upload.controller.ts` |
| Fotos de productos | ya están en **Cloudinary** (`UploadService`). Lo que no se guarda es el zip original ni el Excel | `upload.service.ts` |
| Estado del lote | un hash de Redis `batch:<id>` con caducidad de 24 h (`total`, `processed`, `failed`, `owner`) y un conjunto `batch:<id>:publish:falabella` | `batch-notification.service.ts` |
| Falabella | todo el lote se envía **junto al terminar el último producto** | `publicarFalabellaDelLote` |
| DeepSeek | límite por **concurrencia**: 2500 simultáneas en `deepseek-flash`, 500 en `deepseek-v4-pro`. Sin límite por minuto documentado | api-docs.deepseek.com |
| OpenAI `gpt-4o-mini` | **2,000,000 TPM y 5,000 RPM** (50,000 IPM), en el proyecto por defecto | panel de OpenAI |
| Gasto de OpenAI | $0.26 de $10 del proyecto este mes (tope «not enforced», alerta a $8) | panel de OpenAI |
| Railway | un solo servicio de API (1 réplica, US West), Postgres y Redis aparte con volúmenes. Límite por réplica: **24 vCPU y 24 GB** (plan). Consumo observado: CPU casi 0 con picos de ~1.8 vCPU, RAM base <1 GB con picos de hasta ~5 GB en las cargas | panel de Railway |
| Costo de Railway | $7.72 en el mes, estimado $12.90 | panel de Railway |

Conclusión: **ni los proveedores de IA ni Railway son el límite hoy**. El retraso viene de que el trabajo es en serie. Con 110 productos serían ~31 min solo de IA; con 1000, ~4.7 h.

## 2. Riesgos encontrados en el código

1. **Concurrencia > 1 duplica el cierre del lote.** `trackAndNotify` incrementa el contador y después lo lee en pasos separados. Con dos trabajos terminando a la vez, ambos pueden ver «completo» y mandar el correo dos veces. El envío a Falabella no se duplica porque `takeDeferred` es atómico. **Hay que arreglarlo antes de subir la concurrencia** (usar el valor que devuelve `HINCRBY` o un script atómico).
2. **El estado del lote vive solo en Redis, 24 h.** Si se pierde un trabajo o Redis se reinicia sin copia, el lote nunca «termina» y Falabella no recibe nada. Para 1000 productos hace falta un registro durable en la base.
3. **El zip entra entero en memoria** y todas las fotos se suben antes de responder. Con 1000 productos son miles de fotos y puede ser de GB.
4. **Todo Falabella al final.** Un solo envío con 1000 productos choca con su límite (50 llamadas y 2 min de espera) y deja el lote sin resultados parciales hasta el final.
5. **Sin reparto entre tiendas.** Una carga grande hace esperar a todas las demás.
6. **El SDK de OpenAI y nuestros reintentos se pueden multiplicar** si no los coordinamos (la documentación pide un solo nivel de reintentos).
7. **`deepseek-chat` no aparece en la documentación actual de DeepSeek** (solo `deepseek-flash` y `deepseek-v4-pro`). Hoy funciona; si lo retiran, las cargas fallarían sin aviso. Debe ser una variable de entorno.
8. **La API no tiene `Healthcheck Path` configurado** en Railway: un despliegue con error puede quedar activo. Se propone ponerlo (requiere tu autorización).

## 3. Qué NO haría

- **Un segundo Redis, Kafka o microservicios.** Complejidad sin necesidad hasta pasar de miles de productos por hora. Redis no es el límite.
- **Un modelo más potente para todo.** Sube costo y tiempo sin atacar el cuello de botella. Solo se usa donde hoy se equivoca.
- **Subir la concurrencia primero y arreglar después.** Por el riesgo 1.

## 4. Diseño objetivo (para 1000 productos y varias tiendas)

```
Navegador ──(Excel + zip, directo)──▶ Almacenamiento de objetos
    │                                        │
    └── POST /bulk-upload (solo referencias) ┘
                    │
                    ▼
        Base de datos: bulk_batch + bulk_batch_item (un estado por producto)
                    │
                    ▼
   Cola con prioridad y tope por tienda ──▶ Servicio worker (réplicas)
                                              │  fotos → Cloudinary
                                              │  IA (paralela, con respaldo)
                                              │  validación y reparación
                                              ▼
                                   Limitador por canal (ML, Falabella)
                                   publicación en tandas + control de calidad
```

Decisiones que son difíciles de cambiar después (por eso se diseñan antes de programar):

1. **Tabla de lote e ítems en la base.** Cada producto con su estado: `pendiente → fotos → ia → publicado_ml → enviado_falabella → aprobado` o `fallido(motivo)`. Alimenta la pantalla de progreso, el informe y «Reintentar fallidos», y permite reanudar tras un reinicio. Redis queda solo como cola, no como fuente de verdad.
2. **Subida directa a almacenamiento.** El navegador sube el Excel y el zip por una URL firmada. La API recibe una referencia, no el archivo. El worker lee del almacenamiento y sube solo las fotos de su producto.
3. **Los datos del trabajo llevan referencias, no archivos.** Los trabajos de Redis son pequeños.

Decisiones fáciles de ajustar con medidas: la concurrencia, los modelos, el tamaño de las tandas y los topes por tienda.

## 5. Fases

### Fase 1 — Velocidad sin cambiar la arquitectura (todo apagado por defecto)

Cada cambio entra detrás de una variable de entorno cuyo valor por defecto es el comportamiento de hoy. Un commit por cambio, para poder revertirlos por separado.

| # | Cambio | Variable | Efecto esperado |
|---|---|---|---|
| 1.0 | **Cierre del lote atómico** (riesgo 1) | — | prerrequisito para subir la concurrencia |
| 1.1 | Concurrencia de `generate-listings-queue` con `limiter` | `AI_QUEUE_CONCURRENCY` (por defecto 1) | 29 productos: de ~9 min a ~1-2 min con 6 |
| 1.2 | **Al final, y solo si la concurrencia no basta.** Llamadas independientes en paralelo dentro de un producto: el tamaño del paquete y la categoría de ML (ambos necesitan la visión primero) corren junto a la cadena de categorías; y los atributos de Falabella y ML se piden a la vez. El resto es una cadena (visión → vectores → categoría → verificación → atributos → redacción → ficha HTML) y no se puede paralelizar | `AI_PARALLEL_STEPS` (por defecto apagado) | ~15-25 % por producto (estimado, sin medir; la versión anterior de esta fila decía 30-40 % y suponía que la visión era independiente, lo cual era falso) |
| 1.3 | **Versión reducida (hecha):** hoy todos los productos suben sus fotos a la vez (`Promise.allSettled` sobre todas las filas); ahora se puede limitar cuántos suben a la vez. La versión grande (que las suba el trabajo de cada producto y el botón responda en segundos) queda para la Fase 2, con la subida directa a almacenamiento | `BULK_PHOTO_CONCURRENCY` (por defecto sin límite, tope 50; recomendado 8 en cargas grandes) | baja el pico de memoria y de subidas simultáneas a Cloudinary; **no** acorta la espera del botón |
| 1.4 | Modelo de DeepSeek como variable (**hecho**, `5c6212e`). El limitador de OpenAI (`OPENAI_MAX_RPM`) **se descarta por ahora**: en carga masiva cada producto hace 2 llamadas a OpenAI (visión y vectores); con la concurrencia en su tope de 20 son ~140 llamadas/min, ~100.000 tokens/min y ~280 imágenes/min, contra 5.000 / 2.000.000 / 50.000 de límite. Se retoma si hay varias réplicas o se supera esa escala | `DEEPSEEK_MODEL` (por defecto `deepseek-chat`) | evita fallos si se retira un nombre de modelo |
| 1.5 | **Pospuesto.** El SDK ya respeta `Retry-After` y agrega aleatoriedad (2 reintentos), y cada trabajo tiene 3 intentos con espera exponencial: en el peor caso un 429 se multiplica, pero no hemos visto ningún 429 y los límites están lejos de la escala actual. Se retoma si aparecen 429 en los logs | — | menos fallos por 429 |
| 1.6 | **Ya existía:** la cadena de revisiones de fotos de `falabella-qc` tiene tope (`MAX_REVISIONES_DE_FOTOS = 10`, una revisión por SKU cada 4 min y ventana de 40 min) | — | — |

Subida escalonada: todo apagado y comprobar que nada cambia → concurrencia 2 con 3 productos → concurrencia 6 con ~10 productos mirando la memoria en Railway → recién entonces un lote grande. Si algo falla, se apaga la variable sin redesplegar.

### Fase 2 — Estructura para 1000 (diseñar juntos antes de programar)

1. Tabla de lote e ítems con estados (sección 4).
2. Subida directa a almacenamiento de objetos.
3. Falabella por tandas (cada 25 productos o 5 min), con cada tanda registrada para poder retomarla.
4. Informe del lote y «Reintentar fallidos».
5. **Prueba de carga con canales simulados**: 1000 productos con Mercado Libre y Falabella falsos, para medir memoria, tiempos y profundidad de cola sin tocar productos reales.

**Estado de la Fase 2:** 2.1 (tabla de lote e ítems) hecho; 3 (Falabella por tandas, `FALABELLA_BATCH_SIZE`) hecho; 4 (informe y «Reintentar fallidos») hecho; 5 (prueba de carga) hecha en su versión simulada: `npm run simular:carga -- 1000 6 200 3` (total, concurrencia, tanda, % de fallos de la IA). Pasa el `AiProcessor` real con IA, canales, Redis y base falsos y comprueba que no se pierde ningún producto; **no mide velocidad ni memoria reales** (eso solo se ve en Railway). Falta el punto 2 (subida directa a almacenamiento de objetos).

### Fase 3 — Calidad: validar antes de publicar

1. Capa de validación entre la IA y el canal (unidades, listas de opciones, obligatorios, longitudes) y reparación con el mensaje de error del canal, un reintento.
2. Salida estructurada de la IA para reducir el JSON roto.
3. Revisión de fotos antes de enviar a Falabella (tamaño, fondo, formato). Hoy el motivo del rechazo de calidad solo se ve en Seller Center.
4. Categoría de Falabella dudosa: ofrecer candidatas y pedir confirmación en vez de dejarlas fuera en silencio.

### Fase 4 — Varias tiendas a la vez y modelos

1. **Tope por tienda** (por ejemplo, la mitad de los espacios) y prioridad para lotes chicos.
2. **Servicio worker aparte** en Railway (mismo repositorio, arranca solo los procesadores) para escalar a más réplicas sin frenar la API.
3. **Modelo de respaldo** cuando haya 429, timeout o dos JSON inválidos seguidos. Puede ser `deepseek-v4-pro` con el mismo cliente (500 simultáneas) u OpenAI (hay que agregarlo a «Allowed models» del proyecto).
4. **Modelo más potente solo** para verificar categoría y atributos con listas cerradas. Se decide con un conjunto fijo de ~30 productos de Kassari y su resultado correcto, midiendo errores, tiempo y costo.
5. Métricas y alertas: tiempo por producto, fallos por motivo, profundidad de cola, errores por canal.
6. Revisar el tope de gasto del proyecto en OpenAI ($10, solo alerta) cuando haya varios clientes.

## 6. Expectativa de tiempos (estimación, a validar con la prueba de carga)

| Caso | Hoy | Fase 1 (6 en paralelo, ~10 s por producto) |
|---|---|---|
| 29 productos | ~9 min | ~1-2 min |
| 110 productos | ~31 min | ~4-5 min |
| 1000 productos | ~4.7 h | ~30 min de IA, pero la publicación en Falabella y su control de calidad pueden tomar horas |

Por eso a esa escala la carga debe ser un **proceso en segundo plano con progreso visible**, no una pantalla de espera.

## 7. Riesgos a vigilar

- Subir la concurrencia sin arreglar el cierre del lote (riesgo 1).
- El pico de memoria con varios productos y sus fotos: hoy llega a ~5 GB en una carga y el plan permite 24 GB, pero se mide en cada subida de concurrencia.
- Los límites de Falabella (50 seguidas y 2 min) y de Mercado Libre al publicar más rápido.
- Cambiar de modelo cambia el estilo de los textos ya publicados: probar con el conjunto fijo antes de activarlo.
- Cada tanda de Falabella debe quedar registrada en la base para poder retomarla si el servidor se reinicia.

## 8. Orden recomendado

1. Fase 1 completa, empezando por 1.0 y con todo apagado por defecto.
2. Diseñar la Fase 2 juntos (tabla de lote y almacenamiento) y construir la prueba de carga.
3. Fase 3 y la parte de tope por tienda de la Fase 4.
4. Servicio worker y modelos de respaldo cuando la prueba de carga o varias tiendas lo pidan.

Nada de esto se aplica sin tu autorización: ni variables de Railway, ni productos reales, ni canales.
