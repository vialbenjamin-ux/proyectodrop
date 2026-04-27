# Dashboard de Reportes Shopify × Meta Ads — Handover técnico para la comunidad Claude

Guía completa para armar **tu propio dashboard** de reportes que cruza tu tienda Shopify con tus campañas de Meta Ads, calcula rentabilidad real y genera recomendaciones automáticas. Setup con **Claude Code**, conectado a tus propias APIs.

> ℹ️ **Nota:** El código de referencia que muestra esta guía proviene de [BKDROP](https://bkdrop.netlify.app/), una app interna del autor. **No es la idea que clones BKDROP** — es que aprendas la arquitectura y armes la tuya, con tu marca, tu lógica de negocio y tus tasas. Este documento te enseña a hacerlo paso a paso.

---

## ⚠️ Antes de empezar

**Tiempo estimado:** 60-90 minutos.

**Pre-requisitos:**
- Tienda Shopify con órdenes
- Cuenta Meta Business + al menos una Ad Account corriendo campañas
- Cuenta gratis en GitHub
- Cuenta gratis en Netlify
- Claude Code instalado ([claude.com/claude-code](https://claude.com/claude-code))

**Lo que vas a tener al terminar:**
- Tu propio dashboard en una URL `tudashboard.netlify.app` (o el dominio que elijas)
- 3 pestañas funcionando: Reporte Shopify, Meta Ads con drill-down, Cruce real con rentabilidad
- Conectado a TUS cuentas, no las de nadie más
- Costo total: **$0** mientras estés dentro del Free tier de Netlify (alcanza para uso personal de un negocio chico)

---

## 1. Qué hace el dashboard

### 📊 Tab "Shopify"

KPIs del día / rango de fechas:
- Órdenes totales, unidades vendidas, ventas netas
- Distribución por **fuente UTM** (Meta, TikTok, Google, directo)
- Tabla detallada de productos vendidos
- Comparación vs día anterior con Δ%

### 📈 Tab "Meta Ads"

Performance de tus campañas con **datos reales cruzados con Shopify**:
- Selector de Ad Account si tenés varias
- Filtros: búsqueda por nombre + estado
- Selector de período: hoy / ayer / 7d / 30d / mes actual / mes pasado
- KPIs: gastado, **órdenes reales (Shopify)**, **revenue real**, **CPA real**, **ROAS real**
- Tabla de campañas con: gasto, compras Meta vs órdenes Shopify reales, unidades, CPA real, ROAS real, CTR, CPC, frecuencia
- **Drill-down**: click en una campaña → ver sus conjuntos de anuncios (adsets) con sus métricas

### 📐 Tab "Cruce real"

La métrica que vale para tomar decisiones: **rentabilidad real con modelo COD aplicado**.

- **Modelo COD configurable**: % confirmación × % entrega × costo de envío. Por default 70 / 70 / $8.000 = **49% efectivo**.
- **5 KPIs grandes**: Gasto Meta · Órdenes Shopify · Entregadas (post COD) · ROAS real · **Ganancia neta real**
- **Recomendaciones automáticas**: "🔴 Apagar X — ROAS 0.4x con $80k gastado", "🟢 Escalar Y — ROAS 4.2x estable", "💸 Quemada", "📉 Subreporte de pixel", "⚠️ Saturada (frec >4x)"
- **Tabla por campaña**: gasto, compras Meta vs Shopify, Δ%, CPA real, ROAS real. Click expande mostrando productos + adsets.
- **Tabla por producto**: con **precio y costo unitario editables inline** (override del costo de Shopify cuando cambia tu proveedor), distribución de cantidades (combos 1u/2u/3u típicos de Releasit COD), revenue, gasto atribuido, ROAS, **ganancia neta real con tasas COD**.
- **Tabla acumulado por día**: desglose día a día con gasto, órdenes, revenue, ROAS y ganancia.
- **Comparativo de períodos**: cada KPI tiene Δ% vs período anterior equivalente (verde/rojo).

---

## 2. Stack y arquitectura

| Capa | Tecnología | Por qué |
|---|---|---|
| Frontend | HTML + CSS + JS vanilla — todo inline en `index.html` | Cero build, cero npm install, edición directa con Claude Code |
| Backend / endpoints con secretos | Netlify Functions (Node 22) | Las API keys viven en env vars, nunca en el frontend público |
| Hosting | Netlify | Auto-deploy desde GitHub: `git push` → 30-60s en producción |

**Flujo de un cruce real:**

```
Usuario abre Cruce real
   ↓
Frontend llama a /.netlify/functions/cross-report
   ↓
Function (en paralelo):
   - Fetch órdenes de Shopify (REST API)
   - Fetch insights de Meta (campañas + metadata)
   - Fetch costos de productos vía Shopify GraphQL
   ↓
Cruza por utm_campaign de cada orden ↔ campaign_id de Meta
Calcula KPIs reales, recomendaciones, etc.
   ↓
Devuelve JSON al frontend
   ↓
Frontend renderiza tablas + KPIs aplicando modelo COD configurable
```

**Por qué este stack y no otro:**
- **Vanilla JS, no React/Vue/Next**: cero build time, cero dependencies hell. Editás un archivo, hacés push, anda.
- **Netlify Functions, no Express server**: cero servidor que mantener, cero VPS, escala solo. Y los secretos viven seguros en env vars.
- **Sin DB propia para los reportes**: la data viene en vivo de Shopify y Meta. No hay nada que sincronizar ni que se desincronice.

---

## 3. Servicios externos requeridos

| Servicio | Para qué | Costo | Donde |
|---|---|---|---|
| **GitHub** | Repo del código | Gratis | github.com |
| **Netlify** | Hosting + Functions | Gratis (Free tier) o $19/mes (Pro) si usás muy intensivamente | netlify.com |
| **Shopify** | Tu tienda con órdenes | Lo que ya pagás de tu tienda | shopify.com |
| **Meta Business + Developers** | Para generar System User token | Gratis | business.facebook.com + developers.facebook.com |

---

## 4. Estructura del proyecto

Tu app va a tener este layout:

```
tu-dashboard/
├── index.html                          # Frontend completo (todo inline)
├── netlify.toml                        # Config de Netlify
└── netlify/
    └── functions/
        ├── shopify-report.js           # KPIs Shopify (tab "Shopify")
        ├── meta-ad-accounts.js         # Lista las ad accounts del usuario
        ├── meta-ads-insights.js        # Insights de campañas de Meta (tab "Meta Ads")
        ├── meta-adsets.js              # Insights de adsets de una campaña (drill-down)
        ├── cross-report.js             # Cruce Shopify × Meta + by-day + recomendaciones
        └── cross-report-summary.js     # Versión liviana para comparativo de períodos
```

`netlify.toml`:
```toml
[build]
  publish = "."
  functions = "netlify/functions"
```

**Código de referencia:** podés ver toda la implementación en [github.com/vialbenjamin-ux/proyectodrop](https://github.com/vialbenjamin-ux/proyectodrop). Es la app del autor — usala como inspiración y plantilla, **adaptá lo que necesites** a tu marca y lógica.

---

## 5. Setup paso a paso

### 5.1 Crear tu proyecto con Claude Code

**Opción A — Usar el repo de referencia como plantilla:**

```bash
# Cloná el repo de referencia
git clone https://github.com/vialbenjamin-ux/proyectodrop.git mi-dashboard
cd mi-dashboard

# Eliminá la conexión al repo original
rm -rf .git
git init
git add .
git commit -m "Initial commit"

# Subilo a tu propio repo en GitHub
# (creá primero el repo vacío en github.com)
git remote add origin https://github.com/TU_USUARIO/mi-dashboard.git
git branch -M main
git push -u origin main
```

**Opción B — Empezar de cero con Claude Code:**

```bash
mkdir mi-dashboard && cd mi-dashboard
git init
claude
```

Y dentro de Claude Code:
```
Quiero armar un dashboard de reportes que cruce Shopify con Meta Ads.
Mirá la guía https://github.com/vialbenjamin-ux/proyectodrop/blob/main/HANDOVER_REPORTES.md
y armá la estructura inicial: index.html con secciones de Reportes (Shopify, Meta Ads, Cruce real),
netlify.toml, y los 6 functions en netlify/functions/.

Adaptá el código a:
- Mi marca: [TU MARCA]
- Mi moneda principal: [CLP/USD/MXN/etc]
- Mi tasas COD: [70/70/8000 o las que correspondan a tu negocio]

Ignorá las otras secciones de BKDROP (Productos, Tutoriales, etc) — solo me interesa Reportes.
```

### 5.2 Conectar a Netlify y deployar

1. Andá a https://app.netlify.com/signup
2. **Add new site → Import from Git → GitHub** → elegí tu repo.
3. Build settings: dejar todo en blanco (Netlify lee `netlify.toml`).
4. **Deploy**. En 1-2 minutos queda live en `https://random-name.netlify.app`.
5. Site settings → "Change site name" → poné lo que quieras.

### 5.3 Generar token de Shopify

1. En tu admin de Shopify: **Apps → Develop apps for your store → Allow custom app development → Create custom app**
2. Nombre: `Reportes Dashboard` (o el que prefieras)
3. **Configure Admin API scopes**, marcá:
   - `read_orders`
   - `read_products`
   - `read_inventory` ⚠️ importante para que el cruce traiga los costos automáticamente
4. **Save → Install app → Reveal token once**
5. Copiá el token (empieza con `shpat_`). **Solo se muestra una vez.**

Anotá también tu dominio: `tutienda.myshopify.com`.

### 5.4 Generar System User token de Meta

Esta es la parte más larga. Necesitás un **System User token** que **no expira**, no un user token (que dura 1-2 horas).

#### 5.4.1 Crear app en Meta Developers

1. Andá a https://developers.facebook.com/apps → **Create App**
2. Tipo: **Business** (o **Negocios**)
3. Nombre: el que quieras (ej: `Mi Reportes Sync`)
4. **Connected business asset**: tu Business Manager
5. Una vez creada, anotá el **App ID** (lo vas a necesitar)

#### 5.4.2 Vincular la app al Business Manager

1. https://business.facebook.com/settings/apps
2. **Add → Connect an App ID** → pegá el App ID
3. Asignar **Control total** al usuario admin.

#### 5.4.3 Crear System User

1. https://business.facebook.com/settings/system-users
2. **Add → System User**:
   - Nombre: `Reportes Bot` (o el que prefieras)
   - Rol: **System Admin** (NO empleado)
3. Click sobre el bot recién creado → **Add Assets**:
   - Tipo: **Apps** → seleccioná tu app → permiso: **Manage app**
   - Tipo: **Ad Accounts** → seleccioná las cuentas que quieras leer → permiso: **Manage Ad Account**

#### 5.4.4 Generar el token

1. En el perfil del System User, click **Generate New Token**
2. **App**: tu app
3. **Token expiration: Never** ⚠️ esta es la clave
4. **Permisos a marcar:**
   - ✅ `ads_read`
   - ✅ `ads_management`
   - ✅ `business_management`
   - ✅ `read_insights`
5. **Generate token**
6. **Copiá el token y guardalo en un lugar seguro** (Bitwarden, 1Password, etc). Solo se muestra una vez.

#### 5.4.5 Si te dice "No hay permisos disponibles"

1. https://developers.facebook.com/apps/TU_APP_ID/roles/roles/
2. **Add Administrators** → tipear el nombre del System User → asignar como **Admin**
3. Volver a generar el token.

### 5.5 Configurar env vars en Netlify

En Netlify: **Site settings → Environment variables → Add a variable**

| Nombre | Valor | Para qué |
|---|---|---|
| `SHOPIFY_DOMAIN` | `tutienda.myshopify.com` | Tu dominio Shopify |
| `SHOPIFY_TOKEN` | `shpat_...` | Token Shopify del paso 5.3 |
| `META_ACCESS_TOKEN` | `EAAxxxxxx...` | System User token del paso 5.4 |

Después de cargar las env vars, **forzá un redeploy** para que las functions las tomen:
```bash
git commit --allow-empty -m "chore: redeploy con nuevas env vars"
git push
```

### 5.6 Verificar que todo funciona

1. Abrí tu sitio en `https://tu-dashboard.netlify.app`.
2. Andá a la sección de Reportes.
3. Tab **Shopify** → debería mostrar las órdenes del día.
4. Tab **Meta Ads** → debería listar tus ad accounts y mostrar campañas.
5. Tab **Cruce real** → debería cruzar todo y mostrar KPIs + recomendaciones.

Si algo falla, ver sección **8. Troubleshooting**.

---

## 6. Modelo COD explicado

El **Cruce real** aplica un modelo de cash-on-delivery (COD) configurable porque en dropshipping latinoamericano:

- **No todas las órdenes confirman**: el cliente no contesta el llamado o cancela. Default: **70% confirma**.
- **No todas las que confirman se entregan**: el courier no encuentra el domicilio, el cliente rechaza al recibir. Default: **70% se entrega**.
- **Costo de envío**: pagás el courier por cada despacho aunque no entregue. Default: **$8.000 CLP** (ajustá a la moneda de tu mercado).

**Tasa efectiva = 70% × 70% = 49%**

De cada 100 órdenes que entran a Shopify, solo 49 generan ingreso real.

**Fórmulas que aplica el código:**

```
revenue real     = revenue Shopify × tasa_entrega           (49%)
COGS real        = costo total × tasa_entrega               (49%)
costo envío      = órdenes × tasa_confirmación × $envío    (70%)
ganancia neta    = revenue real − COGS real − spend Meta − costo envío
```

**Nota:** asume que la mercancía no entregada se reusa (no se incurre en COGS). Si tu modelo es distinto (mercancía perdida, courier no cobra si no entrega, etc.), ajustá la fórmula con Claude Code.

**Cuándo ajustar las tasas en la UI:**
- Tu logística mejora → subí confirmación / entrega.
- Producto con problemas de devolución → bajá entrega.
- Courier nuevo o subió precios → ajustá costo de envío.

Los valores se guardan en `localStorage` del navegador y se aplican en vivo (sin re-fetch).

**Importante para tu caso:** los defaults 70/70/8000 son típicos de dropshipping COD chileno. **Si vendés en otro país o con prepago, las tasas son completamente distintas:**
- Prepago + envío estándar (sin COD): probablemente **95% × 95% × tu costo de envío real**
- Mercados como México COD: típicamente entrega más alta (~85%)
- Productos premium: confirmación más alta (~85-90%)

Empezá con tus tasas reales conocidas. Si no las sabés todavía, mirá tu histórico en Releasit / tu courier.

---

## 7. Cómo extender con Claude Code

La forma más eficiente de iterar sobre tu dashboard es con [Claude Code](https://claude.com/claude-code).

### Setup inicial

```bash
cd tu-dashboard
claude
```

Una vez dentro, dale contexto del proyecto:
```
Soy nuevo en este proyecto. Mirá la estructura de archivos y leé index.html
y los functions de netlify/functions/. Dame un resumen de la arquitectura
y después espero instrucciones.
```

### Prompts útiles para iterar

**Cambiar la marca y colores:**
```
Quiero cambiar la paleta de colores del dashboard. Mi marca usa:
- Color primario: #FF6B35 (naranja)
- Color secundario: #004E89 (azul)
- Tipografía: Inter

Actualizá las variables CSS al inicio del index.html y reemplazá la
tipografía actual (DM Mono + Syne) por Inter en todos los lugares.
```

**Agregar una métrica nueva al Cruce real:**
```
En la tabla por campaña del Cruce real, agregá una columna nueva
"COSTO POR CLICK REAL" calculada como gasto Meta dividido por clicks reales
(no los que dice Meta, sino los que llegaron a Shopify según el UTM).
```

**Agregar una recomendación nueva:**
```
En generateRecommendations() de cross-report.js, agregá una regla nueva:
"📊 BAJA CONVERSIÓN" cuando una campaña tiene CTR > 2% pero conversión
(órdenes Shopify / clicks) < 0.5%. Sugerencia: revisar landing page.
```

**Cambiar moneda y formato:**
```
Mi tienda vende en MXN (pesos mexicanos). Buscá fmtMoney() y todas las
referencias a 'CLP' / 'es-CL' y agregá soporte para 'MXN' con formato
'es-MX'. Default debería ser MXN cuando la cuenta de Meta es de México.
```

**Conectar TikTok Ads:**
```
Necesito agregar TikTok Ads al dashboard, similar a como está Meta Ads.
Ya tengo el access_token y advertiser_id. Crear function meta-ads-insights
equivalente para TikTok contra /open_api/v1.3/report/integrated/get/.
Agregar tab "TikTok" en Reportes.
```

**Cambiar umbrales de recomendaciones:**
```
Los umbrales por default de las recomendaciones no calzan con mi
negocio. Hacelos editables desde la UI con sliders en una sección
"⚙️ Configurar alertas", y guardá los valores en localStorage.
Reglas y umbrales actuales están en cross-report.js → generateRecommendations().
```

**Agregar autenticación simple:**
```
Quiero proteger el dashboard con login. Agregá una pantalla de password
al cargar (validar contra una variable hardcoded o env var). Si la
password es correcta, guardar en sessionStorage y mostrar el dashboard.
```

### Workflow recomendado

1. **Editá una sola cosa por vez** y verificá antes de seguir.
2. Para cambios de UI, abrí el sitio en producción mientras trabajás (hard refresh después de cada `git push`).
3. Si rompés algo, **rollback rápido**:
   ```bash
   npx netlify-cli api restoreSiteDeploy --data='{"site_id":"TU_SITE_ID","deploy_id":"DEPLOY_ANTERIOR"}'
   ```

---

## 8. Troubleshooting

### "usage_exceeded" en Meta

**Qué es:** rate limit temporal de Meta Marketing API (200 calls/h por app por user). NO es un baneo.

**Solución:** esperar 1-2 horas a que se libere. Las campañas siguen corriendo, solo afecta lectura por API.

**Prevención:** las optimizaciones del proyecto ya minimizan requests (caché de cuentas 1h, summary liviano para comparativo). Si seguís pegando el techo, dividí el uso en menos refreshes seguidos.

### "usage_exceeded" en Netlify (HTTP 503)

**Qué es:** alcanzaste el techo del plan Free de Netlify (100 GB bandwidth, 100 hours runtime, 125k invocations).

**Solución:**
- **A)** Esperar al próximo ciclo de facturación (gratis).
- **B)** Pasar a Netlify Pro ($19/mes, techos 10x).
- **C)** Comprar créditos puntuales desde el dashboard.

### Token de Meta expira

**Qué es:** generaste un user token (1-2h vida) en lugar de System User token (no expira).

**Solución:** rehacé el setup desde el paso 5.4 con un **System User**. Confirmar con el endpoint `/debug_token` que devuelve `expires_at: 0`.

### El Cruce real no encuentra órdenes vía Meta

**Causa:** tus URL parameters de los ads no tienen `utm_source=meta` o `utm_campaign={{campaign.id}}`.

**Solución:** en cada anuncio (o por defecto en la cuenta) agregá:
```
utm_source=meta&utm_medium={{placement}}&utm_campaign={{campaign.id}}&utm_content={{adset.id}}
```

Después de configurar, las órdenes nuevas van a llevar UTMs y van a matchear.

### El Cruce real no muestra costos

**Causa:** tu token Shopify no tiene scope `read_inventory`, o los productos no tienen costo configurado en Shopify.

**Solución:**
1. Verificá scope: en la app de Shopify (paso 5.3) marcá `read_inventory` y reinstalá.
2. En Shopify Admin → cada producto → variantes → completá el campo **Cost per item**.
3. Como fallback, podés editar el costo manualmente en la tabla por producto del cruce (override en localStorage).

### Las cuentas de Meta no aparecen en el selector

**Causa:** el System User no tiene asignadas las ad accounts.

**Solución:** business.facebook.com → System Users → tu bot → Add Assets → Ad Accounts → seleccionar.

---

## 9. Costos esperados

| Servicio | Uso típico | Costo |
|---|---|---|
| Netlify | Hosting + Functions | Free hasta cierto tope o $19/mes Pro |
| Shopify | Lo que ya pagás | $39/mes Basic en adelante |
| Meta Marketing API | Lectura de tus ads | **$0** (gratis para uso normal) |
| GitHub | Repo público | $0 |

**Total adicional típico para una tienda:** $0 si Free de Netlify alcanza, $19/mes si pasás a Pro.

**Cuándo necesitás Pro:** si abrís el dashboard >50 veces al día o si analizás muchos videos en otras secciones que sumes a la app, vas a tocar el techo Free. Si lo usás solo para reportes, Free alcanza.

---

## 10. Recursos y links

- Código de referencia: https://github.com/vialbenjamin-ux/proyectodrop
- Claude Code: https://claude.com/claude-code
- Meta Marketing API docs: https://developers.facebook.com/docs/marketing-api/
- Shopify Admin API: https://shopify.dev/docs/api/admin
- Netlify Functions: https://docs.netlify.com/functions/overview/

---

## 11. Para terminar

**Esta no es una app cerrada.** Es una **plantilla** para que armes la TUYA. Renombrala, cambiale los colores, agregale las features que necesite tu negocio. El stack está pensado para que con Claude Code, cualquier cambio se traduzca en un prompt simple y veas el resultado en producción a los 30 segundos del git push.

**Lo más valioso de este enfoque:**
- No dependés de un SaaS que cobra por user.
- Los datos NO pasan por servidores de terceros (excepto Shopify y Meta, que ya son tuyos).
- Si Meta o Shopify cambian sus APIs, podés adaptar el código vos mismo en minutos.
- Cualquier feature que pienses, Claude Code la implementa rapidísimo.

Si armaste tu versión y querés compartirla con la comunidad o tenés bugs/mejoras, los pull requests son bienvenidos en el repo de referencia.

¡Suerte y buenas ventas!
