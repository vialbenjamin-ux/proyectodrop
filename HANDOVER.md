# BKDROP — Handover técnico

App de gestión de dropshipping en producción en https://bkdrop.netlify.app/. Esta guía explica cómo está construida, qué servicios externos usa y cómo recrearla desde cero o forkearla y editarla a conveniencia.

---

## ⚠️ ANTES DE EMPEZAR — usa tus propias API keys

Esta guía asume que vas a deployar **tu propia copia** de la app. NO uses las API keys / cuentas del autor original (Benjamin Vial). Específicamente:

- **Firebase:** tienes que crear **tu propio proyecto** en console.firebase.google.com y reemplazar el `firebaseConfig` en `index.html` línea ~1420. Si dejas el del autor, vas a estar **leyendo y escribiendo en SU base de datos**, lo cual rompe todo (tu app y la del autor) y es éticamente incorrecto.
- **Shopify, Gemini, ElevenLabs:** las API keys del autor viven en variables de entorno del Netlify del autor, **no están en el repo**. Cuando deployes tu propia copia en tu Netlify, las env vars empiezan vacías. Tenés que generar las tuyas con tus cuentas y cargarlas en TU Netlify (paso 5.4).
- **Si necesitás permisos pagos** (ej: ElevenLabs Starter $5/mes), pagás con tu tarjeta.

El paso 5.2 (Firebase) y 5.4 (env vars) son los críticos. No los saltees.

---

## 1. Qué es BKDROP

App web (en español) para administrar el día a día de un negocio de dropshipping. Tiene 9 secciones:

| Sección | Qué hace |
|---|---|
| 📦 Productos | Pipeline tipo kanban con etapas (landing, landing publicada, videos, releasit, ads, listo). Cada producto tiene proveedor, costo, comentarios, asignación a un responsable, archivo de fotos, etc. |
| 🎬 Videos | Tutoriales propios organizados por temáticas. URLs de YouTube/Drive. |
| ✨ Prompts | Panel de prompts BK DROP con flujo Master → Imágenes/Copys + análisis de video con Gemini API + voz en off generada con ElevenLabs. Sistema secundario de temáticas para prompts sueltos. |
| 🏭 Proveedores | Catálogo de proveedores con info de contacto, productos que manejan, comentarios. |
| 🧮 Calculadora | BEROAS — calcula precio mínimo sugerido + Break Even ROAS para campañas de ads. |
| 📋 Pendientes | Lista de tareas con prioridad, notas, asignación. |
| 📊 Reportes | KPIs de Shopify en vivo (ventas del día, comparación vs ayer, totales por producto, distribución por UTM source). |
| 📅 Calendario | Vista semanal con eventos. |
| 📁 Archivo | Productos terminados (cuando un producto sale de pipeline va al archivo). Exportable a CSV. |

---

## 2. Stack y arquitectura

**Filosofía:** simple, sin build, sin framework. Un único archivo HTML con todo inline (CSS + JS). Editás un archivo, hacés `git push`, y a los 30 segundos está en producción.

| Capa | Tecnología | Por qué |
|---|---|---|
| Frontend | HTML + CSS + JS vanilla — todo inline en `index.html` (~5000 líneas) | No hay build process, ni dependencias npm, ni framework. Editar es directo. |
| Backend / persistencia | Firebase Firestore | Sync en tiempo real entre dispositivos. Cualquier cambio aparece al instante en otra pestaña. |
| Backend / endpoints con secretos | Netlify Functions (serverless Node 22) | Para llamadas a APIs que requieren API key (Shopify, Gemini, ElevenLabs). La key vive en env vars de Netlify, nunca en el HTML público. |
| Hosting | Netlify | Auto-deploy desde GitHub. `git push` → 30-60s → producción. |
| Auth | Login con usuarios hardcodeados + Firebase doc `users` para permisos | Simple. Admin: "Benjamin". Otros usuarios pueden tener permisos parciales. |
| Tipografías | Google Fonts (DM Mono + Syne) | Vía CDN, no requiere setup. |

**Ventajas del enfoque:**
- Cambios visibles en producción a los 30 segundos.
- Sin npm install, sin webpack, sin nada que pueda fallar al buildear.
- Cualquier persona con conocimientos básicos de HTML/JS puede editar.

**Limitaciones conocidas:**
- El archivo `index.html` ya pesa ~290KB. A largo plazo conviene partir en módulos, pero por ahora aguanta.
- Firestore tiene límite de tamaño por documento (~1MB). Si la cantidad de productos crece a miles, hay que migrar a documentos por entidad.
- Netlify Functions sync tienen 26s de timeout (free tier). El análisis de video con Gemini puede rozar ese límite si el video es largo.

---

## 3. Servicios externos requeridos

Para recrear la app desde cero, necesitás cuentas en estos servicios. Todos tienen free tier que alcanza para uso personal de un negocio chico:

| Servicio | Para qué | Costo | Donde |
|---|---|---|---|
| **GitHub** | Repo del código | Gratis | github.com |
| **Netlify** | Hosting + deploy + Functions | Gratis (100GB bandwidth, 125k function invocations/mes) | netlify.com |
| **Firebase** | Persistencia (Firestore) | Gratis (Spark plan: 50k reads/día, 20k writes/día) | console.firebase.google.com |
| **Shopify** | Tienda — opcional, solo si quieres la sección Reportes | Pago según plan | partners.shopify.com |
| **Google AI Studio (Gemini)** | API de IA para prompts y análisis de video | Gratis (1500 req/día, 15 req/min) | aistudio.google.com |
| **ElevenLabs** | TTS para generar voz en off | Free tier 10k chars/mes, plan pago $5/mes | elevenlabs.io |

---

## 4. Estructura del repo

```
proyectodrop/
├── index.html                      # Todo el frontend inline (HTML + CSS + JS)
├── netlify.toml                    # Config de Netlify (publish + functions)
├── .gitignore                      # Ignora .netlify/ local
├── HANDOVER.md                     # Este archivo
└── netlify/
    └── functions/
        ├── shopify-report.js       # KPIs de Shopify para sección Reportes
        ├── gemini-proxy.js         # Llama a Gemini API (texto + video)
        ├── gemini-upload-init.js   # Inicia upload resumable de video a Gemini
        ├── gemini-file-status.js   # Consulta estado de archivo subido a Gemini
        ├── elevenlabs-voices.js    # Lista voces es-* de la cuenta ElevenLabs
        └── elevenlabs-tts.js       # Genera audio MP3 con ElevenLabs
```

**netlify.toml:**
```toml
[build]
  publish = "."
  functions = "netlify/functions"
```

---

## 5. Setup paso a paso (para recrear desde cero)

### 5.1 — Clonar el repo

```bash
git clone https://github.com/vialbenjamin-ux/proyectodrop.git tu-app
cd tu-app
```

### 5.2 — Crear cuenta en Firebase y conectar

1. Ir a https://console.firebase.google.com/ → "Add project" → nombre (ej: `tudropshipping`).
2. Una vez creado el proyecto: Build → Firestore Database → "Create database" → start in **production mode** → región `southamerica-east1` (más cerca de Chile/Argentina).
3. En Firestore, ir a **Rules** y reemplazar por:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /bkdrop/{doc} {
         allow read, write: if true;
       }
     }
   }
   ```
   ⚠️ Estas reglas son permisivas (cualquier persona con la URL del sitio puede leer/escribir). Si quieres restringir a usuarios autenticados, hay que configurar Firebase Auth y cambiar las rules.
4. Project Settings (engranaje) → "Your apps" → ícono `</>` (web) → registra la app → copia el objeto `firebaseConfig`.
5. En `index.html` buscá `firebase.initializeApp({...})` (línea ~1420) y reemplazá los valores por los tuyos:
   ```js
   firebase.initializeApp({
     apiKey: "AIzaSy...",
     authDomain: "TU-PROYECTO.firebaseapp.com",
     projectId: "TU-PROYECTO",
     storageBucket: "TU-PROYECTO.firebasestorage.app",
     messagingSenderId: "...",
     appId: "..."
   });
   ```
   ℹ️ El `apiKey` de Firebase ES público por design. No es un secreto. Las reglas de Firestore son las que protegen los datos.

### 5.3 — Crear cuenta en Netlify y deployar

1. Ir a https://app.netlify.com/signup → crearse cuenta.
2. "Add new site" → "Import an existing project" → conectar GitHub → elegir el repo.
3. Build settings: dejar todo en blanco, Netlify lee `netlify.toml`.
4. Deploy. En 1-2 minutos la app está viva en `https://random-name.netlify.app`.
5. Site settings → "Change site name" → poné lo que quieras (`bkdrop2`, `tutienda`, etc).

### 5.4 — Configurar variables de entorno en Netlify

⚠️ Las API keys de servicios externos **no van en el repo** y **no se heredan del autor**. Cada quien genera las suyas con sus propias cuentas y las carga en SU Netlify.

Las cargás como env vars en TU Netlify:

Site → Site settings → Environment variables → "Add a variable":

| Variable | Cómo conseguirla | Para qué |
|---|---|---|
| `SHOPIFY_DOMAIN` | Tu dominio Shopify (ej: `tutienda.myshopify.com`) | Sección Reportes |
| `SHOPIFY_TOKEN` | Shopify Admin → Apps → "Develop apps" → crear app → Configure Admin API scopes → habilitar `read_orders`, `read_products` → Install → "Reveal token once" | Sección Reportes |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey → "Create API key" | Sección Prompts (todas las cards de IA) |
| `ELEVENLABS_API_KEY` | https://elevenlabs.io/app/settings/api-keys → "Create new" | TTS de voz en off |

Si no vas a usar Shopify, puedes omitir esas dos vars (la sección Reportes mostrará error pero el resto funciona). Lo mismo con Gemini/ElevenLabs si no vas a usar el panel de prompts.

### 5.5 — Workflow diario

Editás `index.html` (o las functions) localmente con cualquier editor:
```bash
git add index.html
git commit -m "fix: ajusto X"
git push origin main
```
Netlify auto-deploya en 30-60s. La app actualizada queda en producción.

---

## 6. Detalle de cada Netlify Function

### 6.1 — `shopify-report.js`

GET `/.netlify/functions/shopify-report?date=YYYY-MM-DD`

Trae las órdenes de Shopify del día especificado (zona horaria America/Santiago) y devuelve KPIs agrupados por producto y por UTM source. Compara contra el día anterior y muestra % de cambio.

Env vars: `SHOPIFY_DOMAIN`, `SHOPIFY_TOKEN`.

Detección de UTM source:
1. Primero intenta `note_attributes` con clave "utm source" (la que usa el plugin Releasit COD Form).
2. Si no, fallback a `landing_site` parseando `utm_source`.
3. Mapea facebook/instagram/fb/meta → `meta`, tiktok → `tiktok`, google/cpc/adwords → `google`.

### 6.2 — `gemini-proxy.js`

POST `/.netlify/functions/gemini-proxy`
Body: `{ prompt, fileUri?, mimeType?, model? }`
Devuelve: `{ text, model }`

Llama a Gemini 2.5 Flash. Si vienen `fileUri` + `mimeType`, los incluye como parte multimodal (para análisis de video). Si no, llamada de texto puro. Modelo y maxOutputTokens (8192 sin video, 16384 con video) configurados internamente.

Env vars: `GEMINI_API_KEY`.

### 6.3 — `gemini-upload-init.js`

POST `/.netlify/functions/gemini-upload-init`
Body: `{ mimeType, sizeBytes, displayName }`
Devuelve: `{ uploadUrl }` ← URL temporal con `upload_id` (sin la API key).

Inicia un upload resumable a Gemini File API. El frontend después hace PUT directo a Google con esa URL (no pasa por Netlify). Cap de 20MB por archivo.

Env vars: `GEMINI_API_KEY`.

⚠️ Detalle importante: Gemini devuelve la URL con `?key=GEMINI_API_KEY` en query. La function **strippea ese param** antes de devolverla al frontend (el `upload_id` ya autentica solo). Sin ese strip, la API key quedaría expuesta en el navegador.

### 6.4 — `gemini-file-status.js`

GET `/.netlify/functions/gemini-file-status?name=files/abc123`
Devuelve: `{ state, uri, mimeType, name }`

Consulta el estado de un archivo subido a Gemini (PROCESSING / ACTIVE / FAILED). El frontend hace polling cada 2s hasta que esté ACTIVE para entonces ejecutar el prompt.

Env vars: `GEMINI_API_KEY`.

### 6.5 — `elevenlabs-voices.js`

GET `/.netlify/functions/elevenlabs-voices`
Devuelve: `{ voices: [{ id, name, gender, accent, language, use_case, category }] }`

Lista las voces guardadas en la cuenta de ElevenLabs filtradas por `language=es`.

Env vars: `ELEVENLABS_API_KEY`.

### 6.6 — `elevenlabs-tts.js`

POST `/.netlify/functions/elevenlabs-tts`
Body: `{ text, voiceId, modelId? }`
Devuelve: `{ audioBase64, mimeType: "audio/mpeg", chars, model }`

Genera audio MP3 (44.1kHz, 128kbps) usando el modelo `eleven_multilingual_v2` por defecto. Cap de 1500 chars por request (~90s de audio) como safety.

Env vars: `ELEVENLABS_API_KEY`.

---

## 7. Schema de Firestore

Toda la data vive en una sola colección `bkdrop` con dos documentos:

### `bkdrop/state`
Estado general de la app — todos los productos, proveedores, todos, videos, prompts.

```ts
{
  products: Array<{
    id: string,
    name: string,
    owner: string,                  // a quién pertenece (user)
    stage: 'landing'|'landingpub'|'videos'|'releasit'|'ads'|'done',
    stages: { [stageId]: { done: boolean, doneAt: number } },
    supplierId: string,
    cost: number,                    // costo unitario en CLP
    notes: string,
    photos: string[],                // URLs
    comments: Array<{ user, text, ts }>,
    createdAt: number,
    archivedAt?: number              // si está en archivo
  }>,
  suppliers: Array<{ id, name, contact, notes, ... }>,
  todos: Array<{ id, title, priority, notes, done, createdAt, owner }>,
  videos: Array<...>,                // legacy, ahora se usa videoTemas
  videoTemas: Array<{ id, name, items: [{ id, title, url }] }>,
  promptTemas: Array<{ id, name, items: [{ id, title, text }] }>
}
```

### `bkdrop/users`
Permisos por usuario.

```ts
{
  byUser: {
    "Benjamin": { isAdmin: true, perms: { ... } },
    "Otro":     { isAdmin: false, perms: { canEditProducts: true, canSeeReports: false, ... } }
  }
}
```

**Sync en tiempo real:** El frontend usa `onSnapshot` para escuchar cambios. Cuando alguien edita algo en una pestaña, otras pestañas (incluso de otros usuarios) lo ven al instante.

**Persistencia local:** El estado se guarda también en `localStorage` como cache. Si Firebase cae, la app sigue funcionando con la última versión cacheada.

---

## 8. Sección Prompts BK DROP — flujo completo

Esta es la parte más compleja del proyecto. Si Benjamin quiere copiarla, esto es lo que tiene que entender:

### Estructura visual

1. **Panel "FLUJO MASTER → IMÁGENES + COPYS"** con 3 pasos:
   - Paso 1: link/descripción del producto + botón **▶ Ejecutar Master en {IA}**.
   - Paso 2: textarea para pegar la respuesta de la IA + botón **📥 Extraer datos**.
   - Paso 3: campos editables con Ángulo, Problema, Beneficio (auto-rellenados desde la respuesta del Master) + Descuento (manual).

2. **3 cards primarias** debajo del panel:
   - 🖼️ Imágenes Prompt (morado).
   - 📦 Master Prompt (peach) — solo "📋 Copiar" / "Ver" (su ejecución vive en Paso 1).
   - ✍️ Copys Ads (amarillo).

3. **2 cards de análisis de video**:
   - 🎙️ Transcripción VO (teal) — sube MP4, devuelve transcripción + traducción + auto-genera voz off con ElevenLabs.
   - 🎬 Análisis Estratégico (verde) — sube MP4, devuelve análisis completo de creative strategist con 5 voces en off.

4. **"Otros prompts"** (sistema de temáticas legacy) — carpetas colapsables donde se guardan prompts sueltos en Firestore.

### Selector de IA destino

Toggle Claude / Gemini / ChatGPT (default Gemini).

- **Si seleccionas Gemini:** los botones "▶ Ejecutar" llaman a `gemini-proxy` y reciben la respuesta automáticamente.
- **Si seleccionas Claude o ChatGPT:** flujo manual — copia el prompt al clipboard y abre la web de la IA en pestaña nueva. Pegas manualmente.

Esto es porque ni Claude ni ChatGPT tienen forma práctica de auto-enviar prompts vía URL/API gratis.

### Flujo Master con extracción automática

El prompt Master (definido en JS como `BK_PROMPTS.master`) genera una landing page completa con tabla de ángulos, beneficios, testimonios, etc. La función `extraerDatosMaster()` parsea esa respuesta con regex para sacar:

- **Ángulo**: primera fila de la tabla "ÁNGULOS DE VENTA", columna "Nicho".
- **Problema**: misma fila, columna "Problema", reformateado como pregunta.
- **Beneficio**: primera línea con emoji en la sección "BENEFICIOS CLAVE".

Estos valores se inyectan en los otros prompts (Imágenes y Copys) cuando se ejecutan.

### Análisis de video — pipeline completo

Cuando el usuario apreta ▶ Ejecutar en una de las cards de video:

1. **Frontend llama a `gemini-upload-init`** con metadata (mimeType, size).
2. Function pide a Gemini un upload session URL → strippea la API key → devuelve URL al frontend.
3. **Frontend hace PUT directo a Google** con el archivo. (No pasa por Netlify, evitando el límite de 6MB en function bodies.)
4. **Frontend hace polling de `gemini-file-status`** cada 2s hasta que `state=ACTIVE` (típicamente 10-30s para 10MB).
5. **Frontend llama a `gemini-proxy`** con el prompt + el `fileUri` del archivo procesado.
6. Function llama a Gemini con la parte multimodal y devuelve la respuesta.
7. **Frontend muestra la respuesta** en el área `bk-prompt-output` debajo de la card.

### TTS con ElevenLabs (solo Transcripción VO)

El prompt de Transcripción está modificado para devolver la respuesta en este formato:

```
[LOCUCIÓN]
texto traducido limpio...
[/LOCUCIÓN]

[VOZ_ORIGINAL]
genero: masculino|femenino|neutro
edad: joven|adulto|mayor
tono: firme|cálido|conversacional|...
ritmo: rápido|medio|lento
[/VOZ_ORIGINAL]
```

Frontend parsea, muestra solo la locución como output, y usa la caracterización para auto-elegir una voz de ElevenLabs:

- Filtra voces con `language=es` desde `elevenlabs-voices`.
- Score por match: género (+50), use_case mapeado al tono (+30), acento latam neutro (+8), chileno (+4), professional (+2).
- Pre-marca la voz con mejor score con ⭐.

Click en **🔊 Generar audio** → llama a `elevenlabs-tts` → recibe MP3 base64 → lo muestra en `<audio controls>` + link de descarga.

---

## 9. Cómo extender la app

### Agregar una nueva sección (ej: "Inventario")

1. En `index.html`, agrega un botón de tab:
   ```html
   <button class="tab-btn" data-section="inventario" onclick="switchSection('inventario')">📦 Inventario</button>
   ```
2. Más abajo, agrega la div de la sección:
   ```html
   <div id="section-inventario" class="section">
     <!-- contenido -->
   </div>
   ```
3. Agrega la sección al array `SECTIONS` (búscalo en el JS) si quieres que aparezca en el menú móvil.
4. En `switchSection()` agrega `if(s==='inventario') renderInventario();` si necesita render dinámico.
5. Si necesita persistencia, agrega al state inicial: `let state = {..., inventario: []}` y a las funciones `_firebaseReady.load/save`.

### Agregar un nuevo prompt en el panel BK DROP

1. En `BK_PROMPTS` (objeto JS, línea ~2700) agrega una key nueva con tu prompt como template literal.
2. En el HTML, copia la estructura de una card existente (`bk-prompt-card`) cambiando el id, tone y handlers.
3. Si necesita variables del producto, edita `fillBkPrompt()` para inyectarlas en el texto antes del envío.

### Agregar una nueva integración con API externa

1. Creá `netlify/functions/mi-servicio.js` siguiendo el patrón de los existentes (CORS headers, manejo de errores).
2. Agrega la API key como env var en Netlify: `npx netlify-cli env:set MI_SERVICIO_KEY "valor" --context production`.
3. En el frontend, llamala con `fetch('/.netlify/functions/mi-servicio', ...)`.

---

## 10. Comandos útiles

```bash
# Desarrollo local con functions corriendo
npx netlify-cli dev

# Listar env vars de Netlify
npx netlify-cli env:list

# Setear nueva env var
npx netlify-cli env:set MI_VAR "valor" --context production

# Deploy manual (en general no hace falta — git push auto-deploya)
npx netlify-cli deploy --prod --dir=.

# Ver logs de functions en producción
npx netlify-cli logs:function nombre-de-la-function

# Listar últimos deploys
npx netlify-cli api listSiteDeploys --data='{"site_id":"TU_SITE_ID","per_page":10}'

# Rollback a un deploy anterior
npx netlify-cli api restoreSiteDeploy --data='{"site_id":"TU_SITE_ID","deploy_id":"DEPLOY_ID_VIEJO"}'
```

---

## 11. Costos esperados (uso personal)

| Servicio | Uso típico de un negocio chico | Costo |
|---|---|---|
| Netlify | ~10MB transferido/día, ~500 function calls/día | $0 (free tier sobra) |
| Firebase | <500 reads y writes/día | $0 (free tier sobra) |
| Shopify | Plan Basic | $39/mes (lo que ya pagás por la tienda) |
| Gemini API | 50-200 prompts/día | $0 (free tier de 1500/día) |
| ElevenLabs | 10-30 locuciones/mes (~10 min audio) | $0 (free tier 10k chars) o $5/mes Starter |

**Total típico para una tienda activa: ~$5/mes** (solo si usas ElevenLabs intensivamente). Sin TTS y sin Shopify, todo gratis.

---

## 12. Trade-offs y decisiones de diseño

- **¿Por qué un único archivo HTML?** Porque editar es directo. Cualquier persona con navegador y editor de texto puede modificar la app. Cuando empieces a tener 10k+ líneas conviene partir, pero antes de eso es más simple así.
- **¿Por qué Firestore y no PostgreSQL/Supabase?** Sync en tiempo real out of the box, sin servidor que mantener. Si necesitás queries complejas tipo SQL, migrá a Supabase.
- **¿Por qué Netlify Functions y no Vercel/AWS Lambda?** Netlify ya hostea el HTML; tener todo en un proveedor simplifica auth, env vars y deploys.
- **¿Por qué no React/Vue?** Cero compile time, cero `npm install`, cero "funcionaba en local pero no en prod". Si la app crece a algo más grande, conviene migrar.
- **¿Por qué Gemini 2.5 Flash y no Claude/GPT-4?** Free tier muy generoso (1500 req/día), soporta video multimodal nativo, y la calidad alcanza para los prompts típicos de BKDROP.

---

## 13. Contacto / soporte

Repo: https://github.com/vialbenjamin-ux/proyectodrop
App live: https://bkdrop.netlify.app/

Si tienes dudas técnicas concretas, abre un issue en GitHub con el log del error y la URL de la página donde pasó.
