# Módulo de Sincronización de Marketplaces — Documentación

> Estado: **funcional y probado contra Mercado Libre real** (2026-07-15).
> Ramas: `feature/marketplace-sync` (backend) y `feature/marketplace-sync-ui-v2` (frontend, basada en `feature/ui-redesign`).

## 1. Qué hace

Convierte a Synkro de un generador de listings en una plataforma que **publica y sincroniza inventario** con los marketplaces:

- **Conexión OAuth** de la cuenta de vendedor de Mercado Libre de cada usuario (tokens con renovación automática).
- **Publicación asíncrona** de productos (con el contenido generado por la IA) vía cola BullMQ.
- **Sincronización de inventario push**: cambios de stock/precio en Synkro se propagan a todos los canales publicados.
- **Sincronización pull (ventas)**: webhook de Mercado Libre → una venta descuenta stock local y lo propaga a los demás canales (idempotente: una notificación repetida no descuenta dos veces).
- **Resolución de categoría real**: usa la categoría de la Fase A de la IA si es del sitio configurado; si no, cae al predictor oficial de ML (`domain_discovery`).

## 2. Arquitectura (backend `src/sync/`)

| Pieza | Archivo | Rol |
|---|---|---|
| `MarketplaceConnection` | `entities/marketplace-connection.entity.ts` | Tokens OAuth por (usuario, marketplace). Único por par. |
| `ListingLink` | `entities/listing-link.entity.ts` | Vincula producto interno ↔ ítem publicado (ej. `MPE109...`). Fuente de verdad del estado de sync. |
| `MeliApiService` | `meli/meli-api.service.ts` | Cliente HTTP puro de la API de ML (OAuth, items, órdenes, predictor de categoría). |
| `SyncService` | `sync.service.ts` | Toda la lógica de negocio: OAuth, publicar, inventario, órdenes. |
| `SyncProcessor` | `sync.processor.ts` | Worker BullMQ de la cola `marketplace-sync-queue` (jobs: `publish`, `inventory`, `meli-order`). |
| `SyncController` | `sync.controller.ts` | Endpoints REST. |

### Endpoints (prefijo global `/api/v1`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/sync/connections` | JWT | Cuentas conectadas del usuario (sin tokens). |
| GET | `/sync/mercadolibre/auth-url` | JWT | Genera URL de autorización OAuth (state en Redis, TTL 10 min). |
| GET | `/sync/mercadolibre/callback` | pública | Callback OAuth. Guarda la conexión y **redirige al frontend** con `?meli=connected\|error`. |
| DELETE | `/sync/connections/:marketplace` | JWT | Desconecta la cuenta. |
| POST | `/sync/products/:id/publish` | JWT | Encola publicación (body: `{ marketplaces: ["mercadolibre"] }`). Devuelve 202. |
| PATCH | `/sync/products/:id/inventory` | JWT | Actualiza stock/precio local y lo sincroniza con los canales publicados. |
| GET | `/sync/products/:id/status` | JWT | Estado de sync del producto por canal. |
| GET | `/sync/listings` | JWT | Todas las publicaciones del usuario (para la UI de Marketplaces). |
| POST | `/sync/webhooks/mercadolibre` | pública | Recibe notificaciones de ML (tópico `orders_v2`); responde 200 al instante y difiere el trabajo a la cola. |

### Variables de entorno nuevas

```
MELI_CLIENT_ID=        # App ID del DevCenter de Mercado Libre
MELI_CLIENT_SECRET=    # Client Secret
MELI_REDIRECT_URI=     # Debe coincidir EXACTO con la registrada en DevCenter
                       # (formato: https://<dominio>/api/v1/sync/mercadolibre/callback)
MELI_SITE_ID=MPE       # Sitio (MPE = Perú)
MELI_CURRENCY_ID=PEN
MELI_LISTING_TYPE_ID=gold_special
```

## 3. Hallazgos de la API de Mercado Libre (importantes)

1. **`POST /items` ya no acepta `title`**: se envía `family_name` y ML construye el título en el servidor a partir de los **atributos** (`BRAND`, `MODEL` son el mínimo). Enviar `title` da `body.invalid_fields`.
2. **La descripción va aparte**: `POST /items/{id}/description` con `plain_text`.
3. **Predictor de categoría oficial**: `GET /sites/{site}/domain_discovery/search?q=<título>&limit=1` devuelve la categoría real (ej. `MPE3697` para auriculares). Lo usamos como fallback — las categorías sembradas en la BD son de demo con IDs ficticios.
4. **Tokens duran 6 h**: el flujo **Refresh Token debe estar marcado** en el DevCenter o la conexión muere. `SyncService` renueva automáticamente 5 min antes de expirar.
5. **La redirect URI no acepta `localhost`**: para desarrollo se usa un túnel HTTPS (Cloudflare quick tunnel). La URL del túnel cambia en cada arranque → hay que actualizar DevCenter y `.env` cada vez. En producción se resuelve con dominio fijo.
6. **Webhooks**: ML exige responder 200 en <500 ms; por eso el controller encola y responde de inmediato.

## 4. Frontend (rama `feature/marketplace-sync-ui-v2`)

Basada en `feature/ui-redesign` (rediseño amarillo). Archivos nuevos:

- `src/lib/sync-api.ts` — cliente del API de sync.
- `src/components/marketplaces/MarketplacesModule.tsx` — sección Marketplaces: tarjetas de conexión (ML funcional; Shopify/Amazon "Próximamente"), tabla de publicaciones con auto-refresh (20 s) y manejo del retorno OAuth (`?meli=`).
- `src/components/marketplaces/ConnectionCard.tsx`, `ListingsTable.tsx`.
- `src/components/products/PublishProductDialog.tsx` — diálogo Publicar (estado en vivo cada 5 s).

Modificados: `DashboardLayout` (sección marketplaces activa + aterrizaje post-OAuth), `ProductsTable`/`ProductCard`/`ProductsModule` (botón 🚀 Publicar).

## 5. Verificación realizada (2026-07-15)

- Cuenta ML conectada por OAuth real (seller `2541521123`).
- Ítems publicados en vivo en mercadolibre.com.pe:
  - `MPE1090108632` — Auriculares Bluetooth 5.3 (SKU TEST-SYNC-001)
  - `MPE1090224474` — Mouse gamer RGB (SKU TEST-SYNC-002, pipeline 100 % automático)
- Sync de inventario verificado leyendo la API de ML tras el push (stock 10→7, precio 89.90→79.90).
- Webhook probado con notificación simulada (flujo webhook → cola → worker).
- UI verificada en navegador sobre el rediseño, sin errores de consola; `tsc` y build de producción limpios.

## 6. Entorno local de desarrollo (máquina de Jaime)

- PostgreSQL 17 (servicio Windows) + **pgvector 0.8.0 compilado** e instalado.
- Memurai Developer (Redis 7 compatible, servicio Windows).
- cloudflared para el túnel HTTPS de OAuth/webhooks.
- Backend: `npm run start:dev` (puerto 3001, Swagger en `/api/docs`). Frontend: `npm run dev` (puerto 8080).

## 7. Pendientes / roadmap

- [ ] Configurar URL de notificaciones (tópico `orders_v2`) en el DevCenter y probar una venta real.
- [ ] Endpoint para pausar/reactivar publicaciones (el `MeliApiService.setItemStatus` ya existe).
- [ ] Shopify como segundo canal (la cola y el processor ya distinguen por marketplace).
- [ ] Despliegue con dominio fijo (synkroai.com) para eliminar el túnel temporal.
- [ ] Migraciones de TypeORM (hoy `synchronize: true` crea las tablas — no apto para producción).
- [ ] Firma/validación de webhooks y rate-limiting del endpoint público.
