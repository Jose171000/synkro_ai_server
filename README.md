# Synkro AI Server

Backend de la plataforma **Synkro AI** — un SaaS multicanal que usa Inteligencia Artificial para generar y optimizar listings de productos para Amazon, MercadoLibre y Shopify.

---

## 🧠 ¿Qué hace?

Dado el nombre y descripción de un producto, el servidor:
1. **Fase A — Categorización:** genera un embedding vectorial del producto y busca las categorías más similares en la base de datos usando `pgvector` (cosine distance). DeepSeek elige la categoría ideal por marketplace.
2. **Fase B — Generación:** construye un prompt dinámico con las reglas de cada marketplace + atributos requeridos de la categoría, y DeepSeek genera el título, descripción, bullet points y atributos optimizados para SEO.

---

## 🧱 Stack

| Capa | Tecnología |
|---|---|
| Framework | NestJS 11 + TypeScript |
| Base de datos | PostgreSQL + TypeORM + `pgvector` |
| Cola de trabajos | BullMQ + Redis |
| Generación de texto | DeepSeek API (`deepseek-chat`) |
| Embeddings vectoriales | OpenAI `text-embedding-3-small` |
| Storage de imágenes | Cloudinary |
| Email | NodeMailer + Handlebars (SMTP Gmail) |
| Documentación API | Swagger / OpenAPI |

---

## 🚀 Instalación

```bash
# 1. Instalar dependencias
npm install

# 2. Copiar el template de variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# 3. Iniciar en modo desarrollo
npm run start:dev
```

> **Requisitos previos:** PostgreSQL con la extensión `pgvector` habilitada, y una instancia de Redis corriendo.

Para habilitar `pgvector` en PostgreSQL:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## ⚙️ Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto con las siguientes variables:

```env
# ── Base de datos ── #
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=tu_password
DB_NAME=synkro_db

# ── Auth ── #
JWT_SECRET=un_secreto_muy_largo_y_seguro

# ── Entorno ── #
NODE_ENV=development
PORT=3001

# ── Frontend (CORS) ── #
FRONTEND_URL=http://localhost:3000

# ── Email (SMTP Gmail) ── #
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_USER=tu_email@gmail.com
MAIL_PASS=tu_app_password_de_gmail
MAIL_FROM=Synkro <tu_email@gmail.com>

# ── Cloudinary ── #
CLOUDINARY_CLOUD_NAME=tu_cloud_name
CLOUDINARY_API_KEY=tu_api_key
CLOUDINARY_API_SECRET=tu_api_secret

# ── IA ── #
OPENAI_API_KEY=sk-...      # Para embeddings (text-embedding-3-small)
DEEPSEEK_API_KEY=sk-...    # Para generación de listings (deepseek-chat)

# ── Redis ── #
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
```

> **Nota:** Todas las variables marcadas son **obligatorias**. El servidor rechazará arrancar si alguna falta.

---

## 📡 Endpoints Principales

La API corre en `http://localhost:3001/api/v1`.  
La documentación Swagger está disponible en `http://localhost:3001/api/docs`.

### 🔐 Auth — `/api/v1/auth`

| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/register` | Registrar nuevo usuario (devuelve JWT + refresh token) |
| POST | `/login` | Login (devuelve JWT + refresh token) |
| POST | `/refresh` | Renovar access token con refresh token |
| POST | `/logout` | Cerrar sesión (revoca todos los refresh tokens) |
| POST | `/forgot-password` | Solicitar email de recuperación de contraseña |
| POST | `/reset-password` | Restablecer contraseña con token del email |

### 📦 Productos — `/api/v1/products` *(requiere JWT)*

| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/` | Crear producto básico (imágenes como URLs) |
| POST | `/with-files` | Crear producto básico (imágenes como archivos físicos) |
| POST | `/with-ai` | Crear producto + generar contenido IA (imágenes como URLs) |
| POST | `/with-ai/with-files` | Crear producto + IA (imágenes como archivos físicos) |
| GET | `/` | Listar productos con filtros, búsqueda y paginación |
| GET | `/:id` | Obtener producto por ID |
| POST | `/:id/generate-ai` | Generar contenido IA para un producto existente |
| PATCH | `/:id` | Actualizar campos de un producto |
| DELETE | `/:id` | Eliminar un producto |

**Filtros disponibles en GET /products:**
`page`, `limit`, `search`, `marketplace`, `category`, `subCategory`, `minPrice`, `maxPrice`, `inStock`, `sortBy`, `order`

### 🤖 IA — `/api/v1/ai`

| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/generate-listings` | Ejecutar pipeline completo (Fase A + Fase B) |
| POST | `/preview-prompt` | Previsualizar el prompt de generación (sin llamar a DeepSeek) |
| POST | `/preview-categorization` | Previsualizar la categorización (Fase A) |

### 📤 Carga Masiva — `/api/v1/bulk-upload` *(requiere JWT)*

| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/products` | Crear productos en lote via Excel + ZIP de imágenes |
| GET | `/products/status` | Estado de la cola de creación masiva |
| POST | `/products/edit` | Editar productos en lote via Excel (por SKU) |
| GET | `/products/edit/status` | Estado de la cola de edición masiva |
| POST | `/categories` | **[ADMIN]** Cargar categorías en lote via Excel |
| GET | `/categories/status` | **[ADMIN]** Estado de la cola de categorías |
| POST | `/categories/edit` | **[ADMIN]** Editar categorías en lote via Excel |
| GET | `/categories/edit/status` | **[ADMIN]** Estado de la cola de edición de categorías |

**Formato del Excel para carga masiva de productos:**

| Columna | Obligatorio | Descripción |
|---|---|---|
| `sku` | ✅ | Identificador único del producto |
| `productName` | ✅ | Nombre del producto |
| `description` | ✅ | Descripción del producto |
| `image` | ✅ | URL externa (JPG) o ruta dentro del ZIP |
| `targetMarketplaces` | ❌ | Coma-separado, default: `amazon,mercadolibre` |

### 🖼️ Upload — `/api/v1/upload` *(requiere JWT)*

| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/image` | Subir una imagen a Cloudinary (multipart) |
| POST | `/image-from-url` | Validar y registrar imagen externa (JPEG, ≤ 2000×2000px) |

---

## 📦 Módulos

```
src/
├── ai/              # Pipeline IA: categorización vectorial + generación de listings
├── auth/            # JWT, refresh tokens, forgot/reset password
├── bulk-upload/     # Carga masiva via Excel, 4 colas BullMQ
├── categories/      # Entidad marketplace_categories + vector search + seeder
├── common/          # Guards, decorators, interceptors compartidos
├── config/          # Swagger config, TypeORM config
├── mail/            # Templates Handlebars + envío de emails
├── products/        # CRUD de productos + integración IA
├── redis/           # Módulo ioredis inyectable (caché de embeddings)
├── upload/          # Cloudinary upload + validación de imágenes
└── users/           # CRUD de usuarios
```

---

## 🗂️ Marketplaces Soportados

| Marketplace | Generación de listings | Categorización vectorial |
|---|---|---|
| Amazon | ✅ | ✅ |
| MercadoLibre | ✅ | ✅ |
| Shopify | ✅ | ❌ (no hay categorías en DB) |

---

## 🛠️ Scripts

```bash
npm run start:dev    # Desarrollo con hot-reload
npm run start:prod   # Producción (requiere build previo)
npm run build        # Compilar TypeScript
npm run lint         # Linting con ESLint
npm run test         # Tests unitarios
npm run test:e2e     # Tests end-to-end
```

---

## 📝 Licencia

UNLICENSED — Proyecto privado.
