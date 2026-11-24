# Phase 1: Auditoría del ruido - Research

**Researched:** 2026-11-24
**Domain:** Medición de notificaciones (export HTML de Telegram + catálogo de emisores en `nas-dashboard` y `media-stack`)
**Confidence:** HIGH en el dataset, en los emisores y en el catálogo de claves; MEDIUM en la columna de push y en el objetivo de éxito (condicionados por D-03); MEDIUM en el mapa final (es decisión de la fase, no de esta investigación).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Fuentes y acceso
- **D-01:** La fuente primaria es el **export HTML del chat** (`messages.html`, 148 mensajes entre el 25 abr y el 24 nov de 2026), facilitado por el usuario en `/Users/albertsalom/Downloads/ChatExport_NAS Monitor/`. Contiene fecha, remitente y texto de cada mensaje. — **Reversibility:** reversible
- **D-02:** La atribución por emisor (WUD, security-monitor, backup, issue-automator, upgrade) se hace por el texto y por los logs/archivos de estado de `media-stack`; el export solo identifica al bot `NAS Monitor`, no al job que envió.
- **D-03:** El histórico de push del hub (tabla `alerts`) queda como **fuente condicionada**: T3 Code deniega vincular el servidor Oracle desde este hilo (*"needs a live full-access/default calling thread"*) y no hay alias SSH configurado. El plan no puede bloquear la mitad de Telegram por esto; si se resuelve el acceso, el informe añade la columna de push.
- **D-04:** No se añade instrumentación al hub para medir push en vivo en esta fase salvo que falle D-03 y el usuario lo pida después; el export cubre el canal que hoy genera el ruido.

### Ventana histórica
- **D-05:** Se segmenta por **eras de cambio**, no por un periodo plano:

  | Era | Periodo | Mensajes | Ritmo |
  |---|---|---:|---:|
  | E1 pre-arreglos | 25 abr – 27 sep | 8 | 0,04/día |
  | E2 arreglo WUD | 28 sep – 2 nov | 105 | 2,92/día |
  | E3 auto-release | 3 – 12 nov | 20 | 2,00/día |
  | E4 actual | 13 – 24 nov | 15 | 1,15/día |

  La **era actual (E4)** es la línea base de la política; E2 y E3 son comparación; el export completo queda como tendencia. — **Reversibility:** reversible
- **D-06:** El informe debe marcar explícitamente qué mensajes preceden a los commits que cambiaron el comportamiento: `d6831af` (3 nov, silenciar rebuilds de linuxserver en WUD), `38061f0` (3 nov, releases y actualizaciones automáticas), `16d824e` (16 oct, arreglo de avisos de security-updates) y la actualización a WUD 9.8.0 (8 nov).

### Unidad de medida
- **D-07:** Siempre **doble cifra**: eventos reales y mensajes enviados. La política se juzga por mensajes (lo que el operador percibe); la reducción se explica por eventos.
- **D-08:** Un **evento WUD** es una pasada de escaneo con uno o más tags nuevos, no cada contenedor. El detalle por contenedor se queda en la UI de WUD y no vuelve a generar mensajes.
- **D-09:** El informe separa dos clases de ruido que no son lo mismo:
  - **duplicado entre sistemas**: el mismo hecho contado por WUD y por la auto-actualización (13 de 95 mensajes WUD tienen una actualización del mismo contenedor en ±2 días),
  - **repetición del mismo evento**: WUD reavisa del mismo tag pendiente en cada escaneo (11 eventos repetidos, `qbittorrent → ls478` hasta 4 veces).

### Política de canales decidida durante la discusión
- **D-10:** **WUD deja de notificar por Telegram.** Su UI se mantiene para consultar; el digest puede llevar el recuento de actualizaciones pendientes. — **Reversibility:** costly — deshacerlo toca `media-stack` (compose y docs), la política del hub y el digest; el token y los triggers volverían a estar activos en dos sitios.
- **D-11:** **Auto-actualizaciones**: el éxito ("actualizada; salud correcta") va al digest; el fallo y el `manual review` llegan al momento porque exigen acción del operador. — **Reversibility:** costly — cambia qué claves son inmediatas en `policy.ts` y la sección del digest; revertirlo reintroduce el chorro de mensajes de éxito.
- **D-12:** El **objetivo numérico de éxito** no se fija en la discusión: el informe lo propone a partir de E4 (1,15 mensajes/día hoy) y el usuario lo valida al leerlo. — **Reversibility:** reversible

### the agent's Discretion

- Formato exacto del informe (tablas, secciones, nombre del archivo dentro del directorio de la fase).
- Parser del HTML y tratamiento de mensajes sin hora o con fecha duplicada.
- Cómo atribuir emisor cuando el texto es ambiguo (preferir logs de `media-stack` antes que adivinar).
- Estructura de la comparación entre eras y redondeo de los ritmos.
- Si el acceso al Oracle aparece a mitad de fase, cómo incorporar la columna de push sin rehacer el informe.

### Deferred Ideas (OUT OF SCOPE)

- **Vista de actualizaciones disponibles en el hub** — si WUD sale de Telegram, ver el detalle en una vista propia del hub es un candidato para una fase posterior; no está en el alcance de la fase 1 ni en el roadmap actual.
- **Medir push en vivo con un contador temporal** — solo si falla el acceso al Oracle y el usuario lo pide; no es el camino por defecto.
- **Silencio nocturno, presupuesto de supresión y escalado** — ya están en v2 de `REQUIREMENTS.md`; la fase 1 no los decide.

Ninguna idea de la discusión quedó fuera del alcance por error; las tres anteriores son capacidades de otras fases.

### Project Constraints (from AGENTS.md and CODING_STANDARD.md)

- **No escribir código de producto.** La fase mide; el único artefacto ejecutable admisible es la herramienta de análisis y sus tests. Nada de `policy.ts`, outbox, bot ni digest (fases 2–8).
- **`media-stack` es solo lectura.** No hay commits, ni cambios de compose, ni de scripts en ese repo.
- **Los tests no se acoplan al copy.** Un test de la auditoría no puede afirmar "el informe dice «WUD»": afirma conteos, sumas, claves y estructura (`CODING_STANDARD.md`).
- **Idioma:** narrativa e informe en español; encabezados y etiquetas de investigación pueden quedarse en inglés.
- **Datos personales:** `messages.html` no se copia al repo ni se pegan cuerpos de mensajes; solo muestras cortas de campo para documentar el parser.
- **Next.js no es relevante aquí** (la nota de versión de `AGENTS.md` aplica a escribir app; esta fase no lo hace).

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (REQUIREMENTS.md) | Research Support |
|----|-----------------------------|------------------|
| AUDT-01 | El operador dispone de un informe con mensajes/día por emisor (WUD, security-monitor, copia, issue-automator, upgrade, hub) de los últimos 30–90 días | §Dataset Reality Check (parser y ventana real), §Emitter & Key Inventory A (8 filas: 7 emisores identificados + SMART desconocido, con evidencia archivo:línea y conteo), §Measurement Model (denominador y tabla por era) |
| AUDT-02 | El informe separa aperturas de recuperaciones y cuantifica los duplicados push + Telegram del mismo evento | §Measurement Model (definición de recuperación por familia, `alerts.resolvedAt`), §Emitter & Key Inventory A/C (qué familia puede emitir recuperación y cuál no), §Measurement Model (clave de join y latencia) |
| AUDT-03 | El informe incluye distribución horaria y el top 3 de claves por volumen | §Dataset Reality Check (hora local del export, sin doble conversión), §Measurement Model (histograma 0–23, normalización de claves y baseline reproducible) |
| AUDT-04 | El informe fija el mapa definitivo de alerta inmediata, digest o silenciosa, y el orden de apagado de emisores de `media-stack` | §Emitter & Key Inventory B/D (12 claves reales del hub; orden de apagado por volumen, reversibilidad y dependencia), §User Constraints (D-10, D-11 ya fijan dos filas) |
| AUDT-05 | El informe fija el objetivo de éxito medido (mensajes proactivos/día y tiempo hasta reconocer) | §Measurement Model (fórmula del objetivo y baseline E4), §Open Questions (el tiempo hasta reconocer no es medible hoy: no existe evento de ack) |

</phase_requirements>

## Summary

La fase no necesita investigación de tecnología; necesita **un método de medición reproducible sobre un dataset que ya está en disco**. Verifiqué el export: 76.936 bytes, `sha256 fe32cd3a63464261527d74ee77f53696b1b5837f58206230e15fa93291fdbe74`, 148 mensajes (146 del bot, 2 del operador), 45 separadores de fecha y 58 mensajes `joined` sin `from_name`. La estructura es regular pero tiene cinco trampas que cambian el resultado si se parsea con regex: el remitente se hereda en los `joined`, los separadores de fecha no son mensajes, un mensaje usa la secuencia literal `\n` (dos veces) en vez de `<br>`, seis CVE se autolinkan como `tel:` y la hora del export es **hora local del host**, no UTC.

Verifiqué también el inventario real de emisores en `media-stack`: hay **cuatro** puntos que llaman directamente a `api.telegram.org` (`security-monitor/main.py`, `media-backup.sh`, `issue-automator/main.py` y `upgrade.sh`), WUD envía por su trigger configurado, y `updater.py`/`merged_updates.py` notifican a través de `security-monitor`. `auto-release.sh` no envía nada: prepara el release en CI. El hub **no tiene transporte de Telegram** en el código actual: su ruido es Web Push, y por eso el export no puede contener ni una sola recuperación del hub ("Recuperado: …" aparece 0 veces). Esa asimetría es la clave para que AUDT-02 sea honesto.

La recomendación es un script de auditoría en **Python 3.13 solo stdlib** (no hay `bs4` ni `lxml` instalados, y no hacen falta), en dos etapas: normalizar el export a NDJSON en `/tmp` y agregar con funciones puras testeadas con un fixture sintético. El informe sale de un JSON de agregados (sin cuerpos de mensajes) para que la validación Nyquist afirme invariantes y no prosa. La columna de push es **aditiva**: se diseña el esquema ahora y se rellena solo si aparece el acceso a `alerts`; el informe se entrega igual con `—` y una sección de cobertura explícita.

**Primary recommendation:** medir con un parser `html.parser` de profundidad, clasificar por firma de texto (no por remitente ni por prefijo de host), agregar por era con denominador explícito y publicar `01-AUDIT.md` + `01-AUDIT.json`; el push se documenta como no medido, nunca se infiere del volumen de Telegram.

## Architectural Responsibility Map

Esta fase no tiene tiers de aplicación: no hay navegador, servidor ni base de datos en el camino crítico. Las "capabilities" son etapas de un pipeline offline, y mapearlas evita que el plan asigne trabajo al sitio equivocado (por ejemplo, "leer la BD" cuando la BD no está disponible, o "añadir una ruta" cuando basta un script).

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Adquisición del dataset | Sistema de ficheros local (export del operador) | — | El export es un fichero inmutable; no hay API que liste mensajes enviados por el bot (limitación de la Bot API, `SUMMARY.md` §"La auditoría primero") |
| Normalización y parseo | Herramienta de análisis offline (`scripts/audit/`) | — | Es transformación de datos, no producto; no toca `src/` ni la BD |
| Atribución de emisor | Catálogo de código de los dos repos (fuente de verdad) | Archivos de estado en runtime | El texto identifica la firma; el código y los logs prueban qué job la emite (D-02) |
| Cuantificación (eras, claves, horas, duplicados) | Herramienta de análisis offline | — | Funciones puras sobre filas normalizadas; testeables sin red ni BD |
| Evidencia de push | PostgreSQL del hub (`alerts`) | `/api/overview` (UI autenticada) | Condicionada por D-03; el diseño del informe no puede depender de ella |
| Evidencia de entrega real (push enviado vs fallido) | **No existe** | — | `notify()` usa `Promise.allSettled` y no persiste resultado; `alerts` guarda la decisión, no la entrega |
| Síntesis de política (AUDT-04) | Artefacto de planificación de la fase (01-03) | `policy.ts` en fase 2 | La fase fija la tabla; la implementación es de la fase 2 |
| Validación | Vitest/unittest sobre el agregador | Informe como documento | Nyquist exige aserciones sobre datos, no sobre prosa |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Python | 3.13.15 `[VERIFIED: python3 -V]` | Lenguaje del extractor y del agregador | Ya está en la máquina, no añade dependencias y el repo ya usa Python para `agent/` |
| `html.parser` (stdlib) | 3.13 `[VERIFIED: import html.parser]` | Parseo del export | Es un parser real con eventos de start/end tag; permite contar profundidad de `div` y no se rompe con `<br>`, `<strong>` ni `<a>` |
| `json`, `csv`, `datetime`, `hashlib`, `statistics` (stdlib) | 3.13 | Normalización, agregados, hash del dataset, medianas | Sin instalación; el hash del export es la única forma de que el informe sea reproducible |
| `unittest` (stdlib) | 3.13 | Tests de la herramienta | Mismo runner que `pnpm test:agent`; no introduce pytest |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `jq` | 1.7.1 `[VERIFIED: jq --version]` | Inspección manual del NDJSON/JSON de agregados | Solo para depurar; no es dependencia del script |
| `shasum` | macOS `[VERIFIED: shasum -a 256 messages.html]` | Pin del dataset | Una vez, al abrir y al cerrar la fase |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Python stdlib | Node 24 + `cheerio`/`linkedom` | Añade una dependencia de terceros y un `pnpm install` para un one-off; Node 24 no trae `DOMParser`. El repo es TS, pero la fase no es producto |
| Python stdlib | Regex sobre el HTML | Más corto de escribir y **incorrecto**: cualquier respuesta citada o preview introduce un `div` anidado y el `.*?` corta el mensaje. Ya hay 147 coincidencias falsas si se mide `<div class="text">.*?<div` con DOTALL |
| `html.parser` | `BeautifulSoup` | No está instalado (`ModuleNotFoundError: bs4`); instalarlo exige red y no aporta nada sobre un export con 6 tipos de tag |
| Script suelto en `/tmp` | Herramienta versionada en `scripts/audit/` | El script suelto no es reproducible ni testeable; el informe deja de ser auditable cuando cambie el export |

**Installation:**

```bash
# Ninguna. Solo stdlib.
python3 -V   # 3.13.15
```

**Version verification:** ejecutado en esta sesión: `python3 -V` → `Python 3.13.15`; `node -v` → `v24.22.3`; `pnpm -v` → `12.15.0`; `jq --version` → `jq-1.7.1-apple`.

## Package Legitimacy Audit

**No se instala ningún paquete externo en esta fase.** El gate de legitimidad es N/A; se documenta para que el planner no lo eche en falta.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| *(ninguno)* | — | — | — | — | — | No aplica |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
  /Users/.../ChatExport_NAS Monitor/messages.html   (inmutable, sha256 pin)
                    │
                    ▼
        ┌───────────────────────────┐
        │ 1. Extract (html.parser)  │  ignora .message.service (45)
        │    depth-tracked .text    │  hereda from_name en .joined (58)
        └────────────┬──────────────┘
                     │  filas normalizadas (NDJSON en /tmp, NO se commitea)
                     ▼
        ┌───────────────────────────┐      ┌──────────────────────────────┐
        │ 2. Classify (signatures)  │◄─────┤ Catálogo de firmas           │
        │    family + subject + key │      │ (código de ambos repos)      │
        └────────────┬──────────────┘      └──────────────────────────────┘
                     │
                     ▼
        ┌───────────────────────────┐      ┌──────────────────────────────┐
        │ 3. Attribute emitter      │◄─────┤ Evidencia: archivo:línea,    │
        │    (evidence > guess)     │      │ state files (solo lectura)   │
        └────────────┬──────────────┘      └──────────────────────────────┘
                     │
                     ▼
        ┌───────────────────────────┐      ┌──────────────────────────────┐
        │ 4. Aggregate by era       │      │ 5. Push column (opcional)    │
        │    events vs messages     │◄─────┤ alerts at/resolvedAt         │
        │    hours, keys, duplicates│      │ LEFT JOIN legible, nunca     │
        └────────────┬──────────────┘      │ requisito de entrega         │
                     │                     └──────────────────────────────┘
                     ▼
        ┌───────────────────────────────────────────────────────────────┐
        │ 6. 01-AUDIT.json (agregados, sin cuerpos)  →  01-AUDIT.md     │
        └───────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
scripts/
└── audit/
    ├── telegram_export.py        # extract + normalize (impuro: lee fichero, escribe NDJSON)
    ├── noise_audit.py            # classify + aggregate + render (puro; CLI)
    ├── test_telegram_export.py   # unittest del parser
    ├── test_noise_audit.py       # unittest del clasificador y de los invariantes
    └── fixtures/
        └── telegram_export_sample.html   # sintético, sin datos personales

.planning/phases/01-auditor-a-del-ruido/
├── 01-AUDIT.md                   # informe (entregable)
└── 01-AUDIT.json                 # agregados (opcional, sin cuerpos; alimenta fase 2)

/tmp/noise-audit/                 # NO se commitea
├── messages.ndjson               # una fila por mensaje
└── audit-trace.log               # decisiones de atribución dudosas
```

### Pattern 1: Extract → normalize → aggregate (dos stages, una responsabilidad cada uno)

**What:** la etapa 1 convierte HTML en filas planas; la etapa 2 no vuelve a mirar el HTML. El agregador recibe `list[Row]` y devuelve `dict`.
**When to use:** siempre que el input sea un formato externo que puede cambiar; permite testear el agregador con filas escritas a mano y el parser con un HTML mínimo.
**Example:**

```python
# Source: diseño de esta fase (ver §Code Examples para el esqueleto completo)
rows = parse_export(path)          # impuro
summary = aggregate(rows)          # puro, testeable sin fichero
```

### Pattern 2: Clasificar por firma, atribuir por evidencia

**What:** la familia se decide por la **forma estable** del texto (sufijo `— autoactualización de seguridad`, prefijo `New tag found for container `, `Backup of ... FAILED`). El emisor se decide por el catálogo de código y, cuando el texto es ambiguo, por los archivos de estado. Si nada lo prueba, `emitter="unknown"` y el informe lo dice.
**When to use:** el bot siempre se llama `NAS Monitor` y el prefijo del host cambia (`NAS Monitor —`, `Oracle Web —`, `NAS HOME —`): atribuir por prefijo rompe el 12 de noviembre.
**Example:**

```python
SIGNATURES = [
    ("wud",              lambda t: t.startswith("New tag found for container ")),
    ("security-digest",  lambda t: " — " in t and "actualizaciones de seguridad verificadas" in t),
    ("security-update",  lambda t: " — autoactualización de seguridad" in t),
    ("release",          lambda t: " — actualización automática detenida: " in t
                                   or " — actualizado de " in t
                                   or " aplicada y verificada; servicios: " in t),
    ("backup",           lambda t: t.startswith("Backup of ") and " FAILED:" in t),
    ("issue-automator",  lambda t: t.startswith("🚨 Incidencia reportada en Seerr")),
]
```

### Pattern 3: Era con denominador explícito y doble cifra

**What:** cada era tiene `inclusive_days = (last_date - first_date).days + 1` declarado en el JSON; el ritmo es `messages / inclusive_days`, redondeado a 2 decimales. Cada fila lleva `events` y `messages`.
**When to use:** siempre; es la única forma de que E1 y E4 sean comparables y de que el objetivo de AUDT-05 se pueda recalcular.
**Example:**

```python
{"era": "E4", "from": "2026-11-13", "to": "2026-11-24",
 "inclusive_days": 12, "messages": 15, "rate": 1.25,
 "by_family": {"wud": 5, "security-update": 7, "release": 3}}
```

### Pattern 4: Columna de push aditiva (LEFT JOIN, nunca bloqueante)

**What:** el modelo de filas tiene `push_decision_at`, `push_resolved_at`, `push_latency_s` opcionales. Sin acceso a `alerts`, quedan `None` y el informe imprime `—` con una nota de cobertura. Con acceso, se rellena por ventana temporal y clave; el resto del informe no cambia.
**When to use:** D-03. Evita rehacer el informe y evita que un acceso fallido convierta el entregable en "parcial".
**Example:**

```python
row.push = None            # "no medido (D-03)"
row.push_status = "unavailable"
# Si mañana hay CSV: row.push = join_alerts(row, alerts_rows)
```

### Anti-Patterns to Avoid

- **Regex sobre el HTML del export:** los `div` anidados y las respuestas citadas rompen el `.*?`; ya se midió el fallo (147 matches falsos con DOTALL).
- **Atribuir por `from_name`:** 58 de 148 mensajes (`joined`) no lo tienen; el bot se llama igual siempre y el host cambia de prefijo.
- **Promediar el periodo completo:** E2 concentra 105 de 148 mensajes; un promedio plano oculta el efecto de los commits del 16 oct y 3 nov, que es justo lo que el usuario quiere ver (D-05, D-06).
- **Contar mensajes WUD como eventos:** 95 mensajes son 51 pasadas de escaneo; sin agrupar, el "evento" y el "mensaje" se confunden y D-07 pierde sentido.
- **Convertir la hora del export a Madrid:** ya es hora local; convertirla la desplaza 1–2 h y arruina la distribución horaria.
- **Inferir push del volumen de Telegram:** son canales distintos, con emisores distintos y cobertura distinta.

## Dataset Reality Check (verificado en esta sesión)

### El fichero

| Propiedad | Valor | Evidencia |
|-----------|-------|-----------|
| Ruta | `/Users/albertsalom/Downloads/ChatExport_NAS Monitor/messages.html` | `ls -la` |
| Tamaño | 76.936 bytes | `stat -f '%Sm %z bytes'` |
| `sha256` | `fe32cd3a63464261527d74ee77f53696b1b5837f58206230e15fa93291fdbe74` | `shasum -a 256` |
| `mtime` | `Nov 24 16:15:24 2026` (hora local) | `stat` |
| Mensajes | **148** (`90` con `message default clearfix` + `58` con `... joined`) | conteo de clases |
| Remitentes | **146** del bot NAS Monitor y **2** del operador | carry-forward de `from_name` |
| Separadores de fecha | **45**, todos únicos | regex sobre `.message.service .body.details` |
| Días con mensajes | **45** | `Counter(fecha)` |
| Mensajes con hora | **148 / 148** | todos los `title` casan `dd mes yyyy, HH:MM:SS` |
| Ventana efectiva | `2026-04-25 18:13:42` → `2026-11-24 06:08:00` (213 días) | primer/último `dt` |
| Meses presentes | `abril`, `septiembre`, `octubre`, `noviembre` | set de meses |

> El export se generó a las 16:15 del 24 nov; el último mensaje es de las 06:08. La ventana del informe termina en el **último mensaje**, no en la hora de exportación. Declararlo evita que un lector crea que faltan 10 horas de datos.

### Estructura real del markup

```html
<div class="message service">
<div class="body details">
25 abril 2026
</div>
</div>

<div class="message default clearfix" id="message21649">
<div class="pull_left userpic_wrap">...</div>
<div class="body">
<div class="pull_right date details" title="25 abril 2026, 18:15:19">18:15</div>
<div class="from_name">
NAS Monitor
</div>
<div class="text">
🚨 <strong>Alerta SMART - NAS</strong>\n\n🟠 /dev/sdb: 2 sectores pendientes
</div>
</div>
</div>

<div class="message default clearfix joined" id="message21650">
<div class="body">
<div class="pull_right date details" title="25 abril 2026, 18:17:13">18:17</div>
<div class="text">
🚨 <strong>Alerta SMART - NAS</strong><br><br>🟠 /dev/sdb: 2 sectores pendientes
</div>
</div>
</div>
```

Los dos mensajes SMART del 25 de abril son el mismo texto con dos codificaciones distintas: el primero usa la secuencia literal `\n` (backslash + `n`, dos ocurrencias en todo el fichero) y el segundo usa `<br>`. Un parser que solo entienda `<br>` deja el primero en una sola línea; un parser que solo entienda `\n` deja el segundo igual.

### Qué contiene y qué no

| Marcador | Conteo | Implicación |
|----------|-------:|-------------|
| `<div class="text">` | 148 | una por mensaje; los service no tienen texto |
| `<br>` | 317 | separador de línea normal |
| `\n` literal | 2 | normalizar a salto de línea |
| `<a href="tel:…">` | 6 | los CVE se autolinkan como teléfonos; hay que quedarse con el texto, no con el `href` |
| `<strong>` | — | formato; se descarta la etiqueta, se conserva el texto |
| `reply_to`, `forwarded`, `photo_wrap`, `media_wrap`, `link_preview`, `edited` | 0 | no hay respuestas citadas, reenvíos, adjuntos ni ediciones en este export |
| `div` anidado dentro de `.text` | 0 | con este fichero un regex funcionaría; con cualquier respuesta citada, no. El parser no debe asumirlo |

### Reglas de parseo (prescriptivas)

1. Leer el fichero como UTF-8 y **fijar el `sha256`** al abrir; si no coincide, abortar con un mensaje que diga qué hash se esperaba.
2. Recorrer el documento en orden y tratar solo los `div` cuyo `class` sea exactamente `message default clearfix` o `message default clearfix joined` (con `id` que empiece por `message`). Cualquier otro `div` es contenedor.
3. `div.message.service` **no es un mensaje**: su `.body.details` fija la fecha corriente y no emite fila. Contarlos como mensajes infla el total un 30 % (45/148).
4. `joined` significa "mismo remitente que el anterior": si no hay `.from_name`, **heredar** el último visto; nunca dejarlo vacío ni atribuirlo al bot por defecto. Son 58 de 148 (39 %).
5. La hora sale de `.pull_right.date.details[title]`, no del texto visible (`18:15` no tiene segundos). Parsear con un mapa de meses explícito (`abril→4`, …, `diciembre→12`); `%B` depende del locale del proceso y en `C`/`en_US` falla con "abril".
6. El texto se recoge **con seguimiento de profundidad** dentro de `.text`: `br` → `\n`; `strong`/`b`/`i`/`a` → solo su contenido; atributos fuera; `html.unescape` al final; después `text.replace("\\n", "\n")` para el caso literal.
7. Si un `title` no trae hora (`dd mes yyyy`), la fila entra en los conteos diarios con `time=None` y **queda fuera** del histograma horario; se cuenta en `quality.missing_time`. En este export: 0.
8. No agrupar por fecha ni asumir que un separador equivale a un día distinto; en este fichero los 45 separadores coinciden con 45 días, pero es una coincidencia, no una regla.
9. Validar al final: `len(rows) == 148`; `sum(by_family) + operator == len(rows)`; si un mensaje del bot no casa con ninguna firma, va a `unknown` y el informe lo muestra (no se descarta).
10. Guardar el NDJSON en `/tmp/noise-audit/messages.ndjson`; **no** commitear ni el NDJSON ni el HTML.

### Zona horaria: el export ya está en hora local

No hay offset en el fichero. La evidencia de que es hora de pared del host (`Europe/Madrid`) es triple y consistente:

- `scripts/upgrade.sh:30` fija `AT=04:30`, y los mensajes "actualización automática detenida" aparecen a las `04:30:02` (7, 8, 9, 11 y 12 de noviembre).
- `stacks/monitoring/compose.yaml:20` fija `SECURITY_SCAN_CRON: ${SECURITY_SCAN_CRON:-0 6 * * *}`, y los mensajes de autoactualización aparecen a las `06:0x`.
- El log de Docker de WUD del 8 de noviembre tiene prefijo UTC `2026-11-08T05:01:32Z` y dentro dice `[2026-11-08 06:01:32.753]`: el contenedor escribe en hora local CET (+1). El export usa la misma hora de pared.

**Consecuencia:** el histograma horario se calcula con la hora tal cual. Convertirla a Madrid la desplazaría +1 h en invierno y +2 h en verano. La única conversión legítima es de hora de pared a instante (para cruzar con `alerts.at`, que es UTC), y para eso se usa la fecha + `zoneinfo`/`madridDay`, nunca una resta fija.

**DST:** E2 cruza el cambio del 25 de octubre. La distribución horaria sigue siendo válida como percepción del operador; si se compara con timestamps UTC hay que resolver el offset por fecha, no aplicar uno global.

## Emitter & Key Inventory

### A. Emisores de Telegram (verificados en código)

| # | Emisor (job) | Punto de envío (archivo:línea) | Firma del mensaje | Mensajes en el export | ¿Emite recuperación? |
|---|--------------|-------------------------------|-------------------|----------------------:|----------------------|
| 1 | **WUD** (trigger de Telegram del contenedor `wud`) | `media-stack/stacks/monitoring/compose.yaml:78-96`; `TELEGRAM_THRESHOLD: major-only` (línea 92) | `New tag found for container <name>\n\nContainer <name> running with tag <a> can be updated to tag <b>` | **95** | No |
| 2 | **security-monitor** (digest de CVEs verificados) | `stacks/monitoring/security-monitor/main.py:168-176` (`telegram`), `185-206` (`digest`), `255-259` | `<MONITOR_NAME> — <N> actualizaciones de seguridad verificadas\n\n<svc>: <tag> → <tag>\nCorrige <N> CVEs …` | **1** | No |
| 3 | **updater** de seguridad del host (systemd, `security-update.sh`) | `stacks/monitoring/security-monitor/updater.py:297-300` (`notify`), `315` (`label`), `376` (mensaje) | `<MONITOR_NAME> — autoactualización de seguridad\n\n<svc> → <tag>: actualizada; comprobación de salud correcta` / `manual: <razón>` | **31** | Sí: `updater.py:329` → `— recuperación completada: <service>` (0 en la ventana) |
| 4 | **`upgrade.sh`** (upgrade no atendido) | `scripts/upgrade.sh:39-50` (`notify`), `51` (`die`), `30` (`AT=04:30`) | `Media Stack — actualización automática detenida: <error>` / `Media Stack — actualizado de vX a vY y verificado.` | **6** (5 detenidas + 1 actualizado) | No |
| 5 | **`merged_updates.py`** (despliegue automático del host) | `scripts/merged_updates.py:148-163` (`notify`, outbox `notifications.json`), `343` (`aplicada y verificada`), `347` (`falló`) | `<MONITOR_NAME> — vX.Y.Z aplicada y verificada; servicios: a, b` | **4** | No (el fallo emite otro mensaje, no una recuperación) |
| 6 | **backup** (`media-backup.sh`) | `stacks/backup/media-backup.sh:137-146` (`alert`), `148-157` (`finish`) | `Backup of <host> FAILED:\n- <error>` | **2** | **No, por diseño**: el éxito escribe `ok` en `last-status` y no envía nada |
| 7 | **issue-automator** (Seerr) | `stacks/extras/issue-automator/main.py:134-150` (`send_telegram`), `405-411` (incidencia), `314` y `446` (tests) | `🚨 Incidencia reportada en Seerr\n\n🎬 Título: …` / `🧪 Test manual de Issue Automator` | **5** (3 incidencias + 2 tests) | No |
| 8 | **Origen desconocido (SMART)** | **sin código en ninguno de los dos repos** (búsqueda en historia incluida) | `🚨 Alerta SMART - NAS\n\n🟠 /dev/sdb: 2 sectores pendientes` | **2** (25 abr) | No |

**Total: 146 mensajes del bot** = 95 + 1 + 31 + 6 + 4 + 2 + 5 + 2.

**Labels de `d6831af` (verificados):** el commit del 3 de noviembre añadió `wud.tag.transform` a los contenedores linuxserver en `stacks/arr/compose.yaml:11,39,67`, `stacks/vo/compose.yaml:12,43`, `stacks/vpn/compose.yaml:65,97` y `stacks/jackett/compose.yaml:11`. La transformación convierte `-lsNNN` en prerelease para que WUD no lo cuente como major; el commit lo explica: *"WUD coerces tags like 6.4.4.10685-ls320 to 6.4.4, so an -lsNNN rebuild gets semverDiff 'unknown' and bypasses the major-only Telegram threshold."* Es la explicación de por qué E2 tiene 86 mensajes WUD y E4 solo 5.

### Efecto verificado de los hitos de D-06

| Hito | Fecha | Evidencia en el export | Lectura |
|------|-------|------------------------|---------|
| `16d824e` "security-update notifications" | 16 oct | El único digest de seguridad es del **7 oct 19:45**; los mensajes de autoactualización empiezan el 7 oct 20:17 y siguen hasta E4 | El arreglo cambia el formato/contenido, no el volumen; el digest pasa a ser excepcional |
| `d6831af` "silence linuxserver rebuilds" | 3 nov **18:55** | Los 4 WUD de E3 son del 3 nov a las 00:00, 00:01, 12:00 y 18:02 (todos **antes** del commit); desde entonces no hay ni un `-lsNNN` avisado | El commit funciona: los 5 WUD de E4 son majors reales (radarr-vo y radarr 6.4 → 7.0.3, prowlarr 2.7 → 3.0.2/3.1.0, `db` 18 → 19) |
| `38061f0` "release and install compatible updates" | 3 nov | Los mensajes de release empiezan el **6 nov 04:34** (`v2.0.0 → v2.1.0`) y el despliegue automático el 12–14 nov | El flujo nuevo explica los 10 mensajes de release de E3/E4 |
| WUD `9.8.0` (`cc8d8a3`) | 8 nov | WUD vuelve a hablar el **16 nov**; ningún aviso de rebuild | La versión no reintroduce el ruido de `-lsNNN` |

**Consecuencia para el informe:** el descenso E2 → E4 no es un promedio; tiene dos causas separadas —el silenciado de rebuilds (3 nov) y el cambio de flujo de release (3 nov)— y una actualización de imagen (8 nov) que no lo altera. Marcarlas en el eje temporal es lo que pide D-06.
**`auto-release.sh` no aparece en la tabla porque no envía nada**: prepara notas, commit, tag y manifiesto en CI (`scripts/auto-release.sh:1-6,108-110`); su efecto se ve en los mensajes de `merged_updates.py`.

**Hallazgo que cambia el mapa:** el hub **no envía Telegram**. `grep -rn "api.telegram.org" src/ scripts/` no devuelve nada y el historial no tiene transporte de Telegram. El hub emite **Web Push** (`src/lib/push.ts:5-33`). Por tanto:
- la fila "hub" de AUDT-01 es **0 mensajes de Telegram** hoy;
- **"Recuperado: …" no puede aparecer en el export** (0 ocurrencias): las recuperaciones del hub existen, pero en push.

### B. Claves de alerta reales del hub

Todas pasan por `condition()` (`src/lib/collector.ts:25-68`), que abre una fila en `alerts`, envía push y, al resolverse, envía `"Recuperado: " + title` con tag `<host>:<key>-resolved` (`src/lib/collector.ts:41-58`).

| Clave | Origen | Severidad | Debounce | Título de recuperación (push) |
|-------|--------|-----------|----------|-------------------------------|
| `"connection"` | `src/lib/collector.ts:134-152` | `critical` | 60 s | `Recuperado: <host> no responde` |
| `"cpu"` | `src/lib/collector.ts:168-177` | `warning` | `settings.sustainedSeconds` | `Recuperado: CPU elevada en <host>` |
| `"memory"` | `src/lib/collector.ts:178-186` | `warning` | `settings.sustainedSeconds` | `Recuperado: Memoria elevada en <host>` |
| `"disk"` | `src/lib/collector.ts:187-196` | `warning` | 0 | `Recuperado: Queda poco espacio en <host>` |
| `"temperature"` | `src/lib/collector.ts:197-208` | `critical` | 30 s | `Recuperado: Temperatura elevada en <host>` |
| `"container:<name>"` | `src/lib/collector.ts:209-221` | `warning` | 30 s | `Recuperado: Servicio detenido en <host>: <name>` |
| `"backup-failed"` | `src/lib/maintenance-alerts.ts:69` | `critical` | snapshot 60 s | `Recuperado: Copia recuperada` |
| `"disk-health"` | `src/lib/maintenance-alerts.ts:89` | `critical` si `fail`, si no `warning` | snapshot 60 s | `Recuperado: Discos recuperados` |
| `"reboot-pending"` | `src/lib/maintenance-alerts.ts:112` | `warning` | snapshot 60 s | `Recuperado: Reinicio resuelto` |
| `"stack-unit-failed"` | `src/lib/maintenance-alerts.ts:137` | `critical` | snapshot 60 s | `Recuperado: Unidades del stack recuperadas` |
| `"release-retained"` | `src/lib/maintenance-alerts.ts:179` | `warning` | snapshot 60 s | `Recuperado: Releases retenidas resueltas` |
| `"deploy-failed"` | `src/lib/maintenance-alerts.ts:226` | `critical` | snapshot 60 s | `Recuperado: Despliegue recuperado` |

Contrato real de la tabla (`src/lib/schema.ts:134-151`, migración `drizzle/0000_known_madame_hydra.sql:17-25`): `id`, `hostId`, `key`, `title`, `detail`, `severity`, `at`, `resolvedAt`. **No hay `channel`, `deliveredAt`, `notifiedAt` ni `fingerprint`.** Las columnas son camelCase entrecomillado (`"hostId"`, `"resolvedAt"`, ver `drizzle/0003_multi_host.sql:2`), detalle que rompe cualquier SQL escrito con `host_id`.

**Cómo debouncea `condition()` (para leer bien la tabla):** `started` es un `Map` en memoria con clave `<host>:<key>` (`src/lib/collector.ts:16`). En fallo, si no hay fila abierta, solo inserta y notifica cuando `now - started >= duration * 1000`; en éxito borra la entrada del `Map`, resuelve la fila abierta (`resolvedAt`) y envía `"Recuperado: " + title`. La comprobación de fila abierta es una consulta por `(hostId, key, resolvedAt IS NULL)`, no un índice único: dos ciclos concurrentes podrían abrir dos filas. Los snapshots de mantenimiento y despliegues pasan `duration = 0` y se evalúan como mucho una vez por minuto (`ALERT_SNAPSHOT_INTERVAL_MS = 60_000`). El `Map` se pierde en cada reinicio: una condición que llevaba 20 min fallando vuelve a empezar el temporizador. Y `notify()` se llama **después** del `INSERT`, fuera de transacción (`src/lib/collector.ts:63-67`): un crash entre ambos deja la alerta abierta sin push, y `Promise.allSettled` no lo reporta.

**Sobre `src/lib/madrid-day.ts`:** exporta `HUB_TIME_ZONE = "Europe/Madrid"` y `madridDay()` (límites del día calendario), **no un formateador de hora**. Para el histograma no hace falta: la hora del export ya es local. Para cruzar con `alerts.at` (UTC), `madridDay` da los límites del día, no la hora; la conversión pared→instante se hace con `zoneinfo` o `Intl`. No se reutiliza el parser de offset (`madrid-day.ts:42`) para horas sueltas: asume `GMT+HH:MM`, que es correcto para Madrid pero no es un conversor general.

### C. Solapamiento push + Telegram (el "mismo evento por dos canales")

| Evento | Push del hub | Telegram | ¿Duplicado real? | Latencia medible |
|--------|--------------|----------|------------------|------------------|
| Copia fallida | `backup-failed` lee `appdata/backup/last-status` (`agent/maintenance.py:245-248`) | `media-backup.sh:148-156` envía al terminar | **Sí, por construcción**: mismo hecho, dos textos, dos canales | Solo con `alerts.at`; sin Oracle, `—` |
| Copia recuperada | `backup-failed` → `"Recuperado: Copia recuperada"` | **no existe** | No | — |
| Disco SMART | `disk-health` (si el snapshot trae `fail`/`watch`) | 2 mensajes SMART de origen desconocido (25 abr) | Posible, **no probado** | No |
| WUD / security / release / issue | **no existe** | sí | No | — |
| `connection`, `cpu`, `memory`, `disk`, `temperature`, `container:*`, `reboot-pending`, `stack-unit-failed`, `release-retained`, `deploy-failed` | sí | **no existe** | No | — |

**Conclusión para AUDT-02:** el duplicado entre canales es **raro y localizado en la copia**, no el fenómeno dominante. El ruido percibido es **intra-Telegram** (WUD + security-monitor + updater). El informe debe decirlo así; presentar "duplicados push + Telegram" como el gran problema sería falso con los datos disponibles.

### D. Entradas para el orden de apagado (AUDT-04)

| Emisor | % de mensajes (E4) | Reversibilidad | Dependencia | Sustituto listo |
|--------|-------------------:|----------------|-------------|------------------|
| WUD | 5/15 (33 %) | Alta (volver a activar trigger) | **Su API alimenta a security-monitor** (`main.py:48-55`); apagar el trigger no la afecta | Ninguno: el hub no lista tags (fase posterior descartada) |
| updater de seguridad | 7/15 (47 %) | Media | Escribe pins y `.env`; su mensaje de éxito es el que D-11 manda a digest | Ingesta + digest (fases 4 y 9) |
| `merged_updates.py` | 3/15 (20 %) | Media | Despliega releases; el fallo es `deploy-failed` en el hub | Ingesta (fase 9) |
| backup | 0/15 en E4 (2 en E2) | **Baja**: es la única mitigación de "hub caído = silencio" (`PITFALLS.md`, pitfall 24) | Ninguna | **Debe conservarse estrechado** (`SEC-06`), no apagarse |
| `upgrade.sh` | 0/15 en E4 (5 en E3) | Media | Upgrade no atendido | Ingesta (fase 9) |
| issue-automator | 0/15 (3 en E1) | Alta | Actúa sobre Seerr; no es ruido operativo del hub | Fuera del alcance del cutover |
| SMART desconocido | 0 en E4 | — | Ninguna | Sustituido por `disk-health` (push) |

**Orden recomendado para que 01-03 lo ratifique:** (1) `upgrade.sh` y `merged_updates.py`, cuyo **fallo** ya está cubierto por `deploy-failed` y cuyo **éxito** es el caso de D-11 (digest); (2) updater de seguridad (necesita digest, D-11); (3) WUD al final, porque es el mayor volumen, su UI sigue siendo la fuente de verdad de tags y su API alimenta al monitor; (4) backup **no se apaga**, se estrecha a `backup-failed` con origen propio. `issue-automator` y SMART no entran en el cutover.

## Measurement Model

### Unidades y definiciones (las que el plan debe fijar por escrito)

| Concepto | Definición operativa | Por qué |
|----------|----------------------|---------|
| **Mensaje** | Una fila `message default clearfix [joined]` del export, enviada por el bot | Es lo que el operador percibe (D-07) |
| **Evento WUD** | Una pasada de escaneo con ≥1 tag nuevo: mensajes WUD agrupados con hueco ≤5 min | D-08; 95 mensajes son 51 pasadas |
| **Evento de release/updater** | Una ejecución que produce un mensaje (una cabecera `— autoactualización` o `— actualización…`) | El mensaje ya agrega los servicios de esa ejecución |
| **Apertura** | Mensaje que declara un estado de fallo/pendiente nuevo | AUDT-02 |
| **Recuperación** | Mensaje que declara el cese de un estado previamente abierto | **Solo existe en push** hoy; en Telegram: 0 |
| **Duplicado entre sistemas** | Dos mensajes de emisores distintos que describen el mismo hecho, con una clave de join explícita | D-09 |
| **Repetición** | Dos mensajes del mismo emisor con la misma clave de evento | D-09 |
| **Clave** | `familia:asunto` normalizado (`wud:<container>`, `security:digest`, `security:update`, `release:apply`, `release:stop`, `deploy:apply`, `backup:<host>`, `issue:seerr`) | Es la granularidad con la que la fase 2 decidirá canal |
| **Latencia push↔Telegram** | `telegram_sent_at - alerts.at` para el mismo hecho | Solo si hay Oracle; `alerts.at` es la decisión, no la entrega |
| **Denominador** | `inclusive_days = (last_date - first_date).days + 1`, declarado por era | Sin él, E1 y E4 no son comparables |

### Eras: recuento verificado y ritmo recalculado

| Era | Periodo (CONTEXT) | Mensajes (verificado) | Días inclusivos | Ritmo recalculado | Ritmo en CONTEXT |
|-----|-------------------|----------------------:|----------------:|------------------:|-----------------:|
| E1 | 25 abr – 27 sep | **8** | 156 | **0,05/día** | 0,04/día |
| E2 | 28 sep – 2 nov | **105** | 36 | **2,92/día** | 2,92/día |
| E3 | 3 – 12 nov | **20** | 10 | **2,00/día** | 2,00/día |
| E4 | 13 – 24 nov | **15** | 12 | **1,25/día** | 1,15/día |

Los **conteos coinciden exactamente** con CONTEXT (8/105/20/15). Los ritmos de E2 y E3 también. **E1 y E4 no reproducen** con un denominador de días inclusivos: 8/156 = 0,051 y 15/12 = 1,25. O CONTEXT usó otro denominador (8/182 ≈ 0,044; 15/13 ≈ 1,15), o redondeó de otra forma. No es un error de datos, es un **denominador no declarado**, y afecta directamente al objetivo de AUDT-05 porque E4 es la línea base. El plan debe fijar la fórmula y **recalcular E4 = 1,25/día** (o justificar 13 días); no puede heredar 1,15 sin explicar de dónde sale.

### Mensajes por familia y era (verificado)

| Familia | Total | E1 | E2 | E3 | E4 |
|---------|------:|----:|---:|---:|---:|
| WUD | 95 | 0 | 86 | 4 | 5 |
| security digest | 1 | 0 | 1 | 0 | 0 |
| security update (updater) | 31 | 0 | 15 | 9 | 7 |
| release applied (`merged_updates`) | 4 | 0 | 0 | 1 | 3 |
| release stopped (`upgrade.sh`) | 5 | 0 | 0 | 5 | 0 |
| release upgraded (`upgrade.sh`) | 1 | 0 | 0 | 1 | 0 |
| backup failed | 2 | 0 | 2 | 0 | 0 |
| issue incident | 3 | 2 | 1 | 0 | 0 |
| issue test | 2 | 2 | 0 | 0 | 0 |
| SMART (desconocido) | 2 | 2 | 0 | 0 | 0 |
| operador | 2 | 2 | 0 | 0 | 0 |
| **Total** | **148** | **8** | **105** | **20** | **15** |

Ritmo por emisor en E4 (12 días): WUD 0,42/día, security updater 0,58/día, release 0,25/día. En E2 (36 días): WUD 2,39/día, security 0,44/día, backup 0,06/día.

### Las siete cifras que el informe debe producir (`SUMMARY.md` §"La auditoría primero")

| # | Cifra | Cómo se calcula | Estado hoy |
|---|-------|-----------------|------------|
| 1 | Mensajes/día por emisor | mensajes / días inclusivos, por era | ✅ export, verificado |
| 2 | Proporción recuperación : apertura | recuperaciones / aperturas, por canal | ⚠️ Telegram = 0 recuperaciones; push = `resolvedAt` (condicionado) |
| 3 | Incidencias `container:*` simultáneas por caída de host | requiere histórico de `alerts` | ❌ no disponible (D-03) |
| 4 | Duplicados push + Telegram por evento y latencia | join por clave + ventana | ⚠️ estructura medida; latencia no |
| 5 | Distribución horaria | histograma 0–23 con hora local del export | ✅ |
| 6 | Top 3 claves por volumen | `Counter(clave)` | ✅ |
| 7 | Tiempo hasta apertura/ack por severidad | `sentAt → ack` | ❌ no existe evento de ack; solo se fija el objetivo |

**Regla de honestidad:** cada cifra del informe lleva una etiqueta de fuente (`export`, `código`, `state`, `no medido`). Las cifras 3 y 7 se publican como objetivo/`—`, nunca como cero.

### Baseline medida (pre-check reproducible, no es el informe)

Verificada con el clasificador de §Code Examples sobre el export pinneado:

- **Ventanas:** 30 días = 44 mensajes (1,47/día); 60 días = 140 (2,33/día); 90 días = 144 (1,60/día). El export completo es 148/213 días (0,69/día).
- **WUD:** 95 mensajes, 25 contenedores distintos, **51 pasadas** (43 en E2, 3 en E3, 5 en E4) → 1,86 mensajes por evento.
- **Top 3 claves:** `security:update` **31**, `wud:tdarr` **15**, `wud:radarr` **10** (empata con `wud:radarr-vo`; desempate alfabético).
- **Repeticiones WUD:** 11 grupos `(container, target_tag)` repiten → **14 mensajes extra**; `qbittorrent → 5.2.3_v2.0.15-ls478` **4 veces**, `→ …ls480` 3 veces. Coincide con el "11 eventos repetidos" de CONTEXT.
- **Duplicados entre sistemas:** **14** mensajes WUD tienen un mensaje del security-monitor del **mismo contenedor** en ±2 días; **12** comparten además el **mismo tag destino**; **1** corresponde a una actualización real (radarr, +36 h); **13** son `manual: …` (el contenedor **no** se actualizó). El "13 de 95" de CONTEXT se reproduce exactamente como el subconjunto de revisiones manuales; el total honesto es 14 mensajes, de los que solo 1 es una actualización. Etiquetarlos todos como "actualización duplicada" sería falso.
- **Distribución horaria (todo el export):** 00 h → 17, 04 h → 7, 05 h → 1, 06 h → 38, 10 h → 1, 11 h → 1, 12 h → 8, 13 h → 2, 15 h → 5, 16 h → 3, 17 h → 2, 18 h → 29, 19 h → 4, 20 h → 1, 21 h → 8, 22 h → 19, 23 h → 2. En E4: 06 h → 8, 00 h → 3, 17 h → 2, 18 h → 1, 05 h → 1.

### Columna de push (diseño, aunque D-03 no se resuelva)

Modelo de join: por `(clave, ventana)`; `key` de `alerts` es la clave real del hub (tabla B), no la clave normalizada del informe. Mapeo mínimo:

| Clave del informe | `alerts.key` | Ventana |
|-------------------|--------------|---------|
| `backup:<host>` | `backup-failed` | ±10 min del mensaje de Telegram |
| `disk:<device>` | `disk-health` | ±10 min |
| `deploy:*` | `deploy-failed` / `release-retained` | ±2 h |
| `wud:*`, `security:*`, `release:stop` | **sin equivalente** | — |

Cuando el acceso exista, la consulta es (columnas entrecomilladas, `at` es `timestamp without time zone` con hora UTC):

```sql
SELECT "hostId", "key", "severity", "at", "resolvedAt",
       EXTRACT(EPOCH FROM ("resolvedAt" - "at")) / 60 AS open_minutes
FROM "alerts"
WHERE "at" >= (now() AT TIME ZONE 'UTC') - interval '90 days'
ORDER BY "at";
```

Alternativa sin SQL: `GET /api/overview?host=…` devuelve los **últimos 100** `alerts` (`src/app/api/[...path]/route.ts:279-290`), suficiente para una muestra, no para 90 días. El operador puede exportarlos desde la UI autenticada; el informe acepta un CSV `hostId,key,severity,at,resolvedAt`.

**Cómo se incorpora sin rehacer el informe:** el JSON de agregados ya tiene los campos `push_*` a `null`; el render imprime `—`. Rellenarlos es un `LEFT JOIN` posterior y una nota de cobertura; ninguna tabla ni conclusión cambia de forma.

### Secuencia recomendada para los tres planes del ROADMAP

| Plan | Contenido | Depende de | No debe incluir |
|------|-----------|------------|-----------------|
| **Wave 0 (dentro de 01-01)** | `scripts/audit/` + fixture sintético + tests de parser e invariantes | Nada | Cifras del informe |
| **01-01** inventario + recolección | Parser, normalización a NDJSON, tabla de emisores con evidencia, cobertura del dataset (hash, ventana, 45 días, 148 mensajes) | Wave 0 | Duplicados, horas ni mapa |
| **01-02** cuantificación | Mensajes/día por emisor y era, recuperaciones por canal, duplicados 14/12/13/1, histograma, top 3, baseline 30/60/90 | 01-01 | Mapa de canales ni objetivo |
| **01-03** política | Mapa `immediate`/`digest`/`silent` para las 12 claves + familias, orden de apagado, objetivo de éxito, render de `01-AUDIT.md`/`.json` | 01-02 | Implementar `policy.ts` ni tocar `media-stack` |

**Por qué Wave 0 va dentro de 01-01:** el ROADMAP fija tres planes y no conviene añadir un cuarto; pero sin tests el parser no es verificable. Es una tarea de 01-01 con su propio commit, no un plan aparte.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Parsear HTML | Un regex con `.*?` o un split por `</div>` | `html.parser` con pila de profundidad | Cualquier respuesta citada o preview anida `div`; el regex corta el mensaje y no avisa |
| Parsear fechas en español | `strptime(..., "%d %B %Y")` | Mapa explícito `{"abril": 4, …}` + `datetime(...)` | `%B` depende del locale del proceso; en `C`/`en_US` lanza `ValueError` con "abril" |
| Zona horaria | Restar 1 o 2 horas "porque es Madrid" | `zoneinfo`/`madridDay` solo para pared→instante; el histograma usa la hora tal cual | El export ya es local; el offset cambia el 25 oct |
| Emparejar duplicados | Fuzzy match por texto o por contenedor | Clave de join explícita `(container, target_tag)` y ventana declarada | El match por contenedor da 14 mensajes: solo 12 comparten el tag exacto y 13 son revisiones manuales, no actualizaciones |
| Estadística | Media y desviación a mano | `statistics.median`, `Counter`, `sum` | Menos código y reproducible |
| Serializar | Concatenar strings para JSON/CSV | `json`, `csv` de stdlib | Escapes y comas; el informe se valida por schema |
| Medir eventos WUD | Contar mensajes | Agrupar por hueco ≤5 min | 95 mensajes ≠ 95 eventos; D-08 exige la pasada |

**Key insight:** en esta fase el coste no está en escribir el parser, está en **creer que el dataset es más simple de lo que es**. Las cinco trampas del export (joined, service, `\n`, `tel:`, hora local) cambian cifras, no formato; un atajo no falla, da un número plausible y equivocado.

## Common Pitfalls

### Pitfall 1: Regex sobre el HTML del export
**What goes wrong:** el mensaje se corta en el primer `</div>` y el texto sale truncado; con respuestas citadas, el `from_name` se confunde con el del quote.
**Why it happens:** el export parece regular (solo 6 tipos de tag), pero la estructura no está garantizada.
**How to avoid:** parser con pila; ignorar todo `div` que no sea el de mensaje o el `.text`.
**Warning signs:** algún mensaje con texto vacío, o longitudes sospechosamente redondas.

### Pitfall 2: Perder los 58 mensajes `joined`
**What goes wrong:** 39 % de los mensajes quedan sin remitente, o se atribuyen al bot por defecto.
**Why it happens:** `joined` no trae `.from_name` ni userpic; es una optimización visual de Telegram.
**How to avoid:** carry-forward del último remitente; test explícito con dos mensajes joined seguidos.
**Warning signs:** `Counter(sender)` con una clave `None` o con 90 bot en vez de 146.

### Pitfall 3: Contar los separadores de fecha como mensajes
**What goes wrong:** el total sube a 193 y los mensajes/día un 30 %.
**Why it happens:** `.message.service` comparte la clase `message`.
**How to avoid:** seleccionar solo `message default clearfix`, y usar el service solo para fijar la fecha.
**Warning signs:** 45 filas con texto vacío y sin `id`.

### Pitfall 4: El `\n` literal del primer mensaje
**What goes wrong:** el cuerpo SMART del 25 abr sale en una sola línea y el clasificador no lo reconoce.
**Why it happens:** el export mezcla `<br>` (317) con la secuencia literal `\n` (2, en un solo mensaje).
**How to avoid:** normalizar ambos después del unescape.
**Warning signs:** un mensaje con `\n` visible en el texto extraído.

### Pitfall 5: Los CVE autolinkados como `tel:`
**What goes wrong:** si se concatena el `href`, aparecen `tel:2026-103111` dentro del texto y se rompe el conteo de CVEs o el ancho del digest.
**Why it happens:** Telegram autolinkea `CVE-2026-103111` como número de teléfono.
**How to avoid:** descartar atributos; quedarse solo con el contenido de texto.
**Warning signs:** cadenas `tel:` en el NDJSON.

### Pitfall 6: Convertir la hora del export a Madrid
**What goes wrong:** el histograma se desplaza 1 h (invierno) o 2 h (verano); los picos de las 06:00 pasan a las 05:00.
**Why it happens:** se asume que el export está en UTC porque los logs de Docker sí lo están.
**How to avoid:** usar la hora tal cual para la distribución; convertir solo para cruzar con `alerts.at`.
**Warning signs:** un mensaje de `upgrade.sh` a las 04:30 aparece a las 03:30.

### Pitfall 7: Parsear meses con `%B`
**What goes wrong:** `ValueError: time data '25 abril 2026…' does not match format`.
**Why it happens:** el locale del proceso no es español.
**How to avoid:** mapa explícito de los 12 meses.
**Warning signs:** funciona en la máquina del operador y falla en CI.

### Pitfall 8: Ritmos sin denominador declarado
**What goes wrong:** el informe hereda 0,04/día y 1,15/día de CONTEXT, que no reproducen con días inclusivos (0,05 y 1,25).
**Why it happens:** el denominador se calculó de otra forma y no se documentó.
**How to avoid:** `inclusive_days` por era en el JSON y fórmula escrita; validar que `messages / days == rate`.
**Warning signs:** dos informes con el mismo conteo y distinto ritmo.

### Pitfall 9: Llamar "duplicado" a una revisión manual
**What goes wrong:** se afirma que 13 actualizaciones ocurrieron dos veces, cuando el security-monitor dijo `manual:` y **no actualizó nada**.
**Why it happens:** el join por contenedor y ±2 días no distingue un update de un aviso de revisión.
**How to avoid:** reportar tres cifras: mismo contenedor (14), mismo tag destino (12), actualización real (1); y nombrar el par como "mismo pendiente avisado por dos sistemas".
**Warning signs:** el informe dice "duplicados de actualización" sin citar `manual:`.

### Pitfall 10: Contar mensajes WUD como eventos
**What goes wrong:** 95 "eventos" cuando hubo 51 pasadas; la reducción por agrupación se calcula mal.
**Why it happens:** WUD manda un mensaje por contenedor, no por pasada.
**How to avoid:** agrupar por hueco ≤5 min y reportar mensajes/evento.
**Warning signs:** `events == messages` para WUD.

### Pitfall 11: Atribuir por remitente o por prefijo del host
**What goes wrong:** el 12 de nov los mensajes pasan de `NAS Monitor —` a `Oracle Web —` y luego a `NAS HOME —`; y el bot siempre se llama `NAS Monitor`.
**Why it happens:** el prefijo es `MONITOR_NAME` (configurable por host) y el remitente es el bot.
**How to avoid:** clasificar por firma estable (sufijo/prefijo del cuerpo); usar `emitter="unknown"` si nada casa.
**Warning signs:** una familia con 0 mensajes justo después de un cambio de host.

### Pitfall 12: Interpretar "0 recuperaciones" como "no hubo recuperaciones"
**What goes wrong:** el informe concluye que el sistema no genera ruido de recuperación, cuando el hub sí lo genera (push) y el export no lo puede contener.
**Why it happens:** se mide el canal equivocado (Telegram) para un emisor que solo habla push.
**How to avoid:** separar por canal; declarar que Telegram no tiene recuperaciones del hub y que la recuperación del hub vive en `alerts.resolvedAt`.
**Warning signs:** la frase "no hay mensajes de recuperación" sin decir "en Telegram".

### Pitfall 13: Confundir `alerts` con el histórico de entregas
**What goes wrong:** se cuenta como "push enviado" lo que solo es "decisión de alerta"; `notify()` usa `Promise.allSettled` y se traga el fallo (`src/lib/push.ts:14-33`).
**Why it happens:** no hay columna de entrega ni de canal en la tabla.
**How to avoid:** llamar a la columna "decisión de push"; si se quiere entrega, es instrumentación de otra fase.
**Warning signs:** "latencia de push" calculada sin ningún `deliveredAt`.

### Pitfall 14: Planificar 90 días de logs
**What goes wrong:** el plan asume que los logs cubren la ventana; no lo hacen.
**Why it happens:** se confunde el export (90+ días) con los logs de Docker (días) y el journal (ilegible sin `adm`).
**How to avoid:** el export es la fuente; los logs solo corroboran. Verificar fechas antes de prometer cobertura.
**Warning signs:** un paso del plan que dice "leer los logs de septiembre".

### Pitfall 15: Reexportar el chat a mitad de fase
**What goes wrong:** cambian los `id`, el orden y el markup; las cifras dejan de reproducirse.
**Why it happens:** el operador sigue usando el chat y el export es una foto.
**How to avoid:** pin del `sha256` y de la ventana efectiva (`2026-11-24 06:08:00`); si se reexporta, se versiona como `messages-2.html` y se comparan totales.
**Warning signs:** el hash no coincide y el informe no lo dice.

### Pitfall 16: Commitear datos personales
**What goes wrong:** el NDJSON con títulos de películas, usuarios de Seerr y CVE acaba en git.
**Why it happens:** se commitea "para que sea reproducible".
**How to avoid:** NDJSON solo en `/tmp`; al repo van agregados y un fixture sintético.
**Warning signs:** `.planning/` con cuerpos de mensajes.

### Pitfall 17: Depender de archivos de estado que el usuario no puede leer
**What goes wrong:** el plan incluye leer `failed-release.json` o `merged-releases/` por SSH y falla con `Permission denied`.
**Why it happens:** los escribe root con modo 700 en `APPDATA_ROOT`; el usuario `alberba` no es root.
**How to avoid:** tratarlos como corroboración opcional; el hub-agent sí los lee, el operador no.
**Warning signs:** `ls: cannot open directory .../merged-releases/: Permission denied`.

## Code Examples

### 1. Parser con profundidad (stdlib, sin dependencias)

```python
# Source: diseño de esta fase; verificado contra messages.html (148 filas)
from html.parser import HTMLParser

MESES = {"enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5,
         "junio": 6, "julio": 7, "agosto": 8, "septiembre": 9,
         "octubre": 10, "noviembre": 11, "diciembre": 12}

def normalize_text(value: str) -> str:
    return value.replace("\\n", "\n").strip()   # el literal del primer SMART

class TelegramExport(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)  # entidades ya resueltas
        self.rows, self.row = [], None
        self.sender = self.date = None
        self.mode = None          # "service" | "from" | "text"
        self.depth = 0            # profundidad de div dentro del buffer
        self.buf = []

    def handle_starttag(self, tag, attrs):
        a, cls = dict(attrs), dict(attrs).get("class", "")
        if tag == "div" and "message service" in cls:
            self.mode, self.depth, self.buf = "service", 1, []
        elif tag == "div" and cls.startswith("message default clearfix"):
            self.row = {"id": a.get("id"), "joined": "joined" in cls}
        elif tag == "div" and "from_name" in cls and self.row is not None:
            self.mode, self.depth, self.buf = "from", 1, []
        elif tag == "div" and "pull_right date details" in cls and self.row is not None:
            self.row["title"] = a.get("title")          # no el texto "18:15"
        elif tag == "div" and cls == "text" and self.row is not None:
            self.mode, self.depth, self.buf = "text", 1, []
        elif tag == "div" and self.mode:
            self.depth += 1                             # div anidado: no cerrar aún
        elif tag == "br" and self.mode == "text":
            self.buf.append("\n")

    def handle_endtag(self, tag):
        if tag != "div" or not self.mode:
            return
        self.depth -= 1
        if self.depth:
            return
        value = "".join(self.buf).strip()
        if self.mode == "service":
            self.date = value                           # fija la fecha, no emite fila
        elif self.mode == "from":
            self.sender = value
        elif self.mode == "text":
            self.row.update(text=normalize_text(value), sender=self.sender,
                            date=self.date)
            self.rows.append(self.row)                  # joined hereda self.sender
            self.row = None
        self.mode, self.buf = None, []

    def handle_data(self, data):
        if self.mode:
            self.buf.append(data)
```

### 2. Clasificador por firma (orden importa)

```python
# Source: firmas verificadas en media-stack (ver §Emitter & Key Inventory)
import re
from datetime import datetime

def parse_title(title: str):
    date, _, clock = title.partition(", ")              # "25 abril 2026, 18:15:19"
    day, month, year = date.split()
    h, m, s = (int(x) for x in clock.split(":"))
    return datetime(int(year), MESES[month], int(day), h, m, s)

def classify(text: str) -> dict:
    if text.startswith("New tag found for container "):
        m = re.search(r"container (\S+).*running with tag (\S+) can be updated to tag (\S+)", text, re.S)
        return {"family": "wud", "container": m.group(1),
                "from_tag": m.group(2), "target_tag": m.group(3)}
    if " — " in text and "actualizaciones de seguridad verificadas" in text:
        return {"family": "security-digest"}
    if " — autoactualización de seguridad" in text:
        return {"family": "security-update",
                "outcomes": [ln for ln in text.split("\n")[1:] if " → " in ln]}
    if " — actualización automática detenida: " in text:
        return {"family": "release-stop"}
    if " aplicada y verificada; servicios: " in text:
        return {"family": "release-apply",
                "services": text.split("servicios: ", 1)[1].split(", ")}
    if " — actualizado de " in text and text.rstrip().endswith(" y verificado."):
        return {"family": "release-upgrade"}
    if text.startswith("Backup of ") and " FAILED:" in text:
        return {"family": "backup", "host": text.split("Backup of ", 1)[1].split(" FAILED:", 1)[0]}
    if text.startswith("🚨 Incidencia reportada en Seerr"):
        return {"family": "issue-incident"}
    if text.startswith("🧪 "):
        return {"family": "issue-test"}
    if text.startswith("🚨 Alerta SMART"):
        return {"family": "smart", "emitter": "unknown"}
    return {"family": "unknown"}                          # se cuenta y se muestra
```

### 3. Join de duplicados por mensaje WUD (una fila por mensaje, no por par)

```python
# Source: D-09 + verificación de esta sesión (14 mensajes: 13 manual + 1 real; 12 con tag exacto)
from datetime import timedelta

def duplicates_by_wud_message(wud, security_updates, window=timedelta(days=2)):
    rows = []
    for w in wud:
        hits = [s for s in security_updates
                if s["container"] == w["container"]
                and abs(s["at"] - w["at"]) <= window]
        if not hits:
            continue
        # Si hay una actualización real y una revisión manual, manda la real.
        best = next((s for s in hits if s["outcome"] == "updated"), hits[0])
        rows.append({
            "container": w["container"],
            "wud_target": w["target_tag"],
            "same_target": any(s["target_tag"] == w["target_tag"] for s in hits),
            "outcome": best["outcome"],            # "updated" | "manual"
            "latency_min": min(round((s["at"] - w["at"]).total_seconds() / 60) for s in hits),
        })
    return rows

def summarize(rows):
    return {
        "same_container_2d": len(rows),                                  # 14
        "same_target_2d": sum(r["same_target"] for r in rows),           # 12
        "real_update_2d": sum(r["outcome"] == "updated" for r in rows),  # 1
        "manual_only_2d": sum(r["outcome"] == "manual" for r in rows),   # 13
    }
# El "13 de 95" de CONTEXT es manual_only_2d; el total de mensajes WUD
# afectados es 14. Contar pares (WUD x línea de security) da 20 y es incorrecto.
```

**Regla:** se cuenta **una vez por mensaje WUD**, nunca por par. Un mismo mensaje WUD puede casar con dos líneas del security-monitor (misma ejecución o ejecuciones próximas); contar pares da 20 y sobrecuenta.

### 4. Histograma horario sin doble conversión

```python
# Source: §Dataset Reality Check; la hora del export ya es Europe/Madrid
from collections import Counter

def hour_histogram(rows):
    # rows con time=None se excluyen y se cuentan aparte
    return {
        "buckets": {h: n for h, n in sorted(Counter(r["at"].hour for r in rows if r["at"]).items())},
        "missing_time": sum(1 for r in rows if not r["at"]),
    }
```

### 5. Invariantes que el agregador debe cumplir

```python
# Source: CODING_STANDARD.md (los tests afirman comportamiento, no copy)
assert sum(summary["by_family"].values()) + summary["operator"] == summary["total"]
assert sum(summary["by_era"][e]["messages"] for e in ("E1", "E2", "E3", "E4")) == summary["total"]
for e, data in summary["by_era"].items():
    assert data["messages"] / data["inclusive_days"] == data["rate"]
assert summary["wud"]["messages"] >= summary["wud"]["scan_passes"]
```

## Runtime State & Evidence Sources

No es una fase de migración, así que no hay inventario de estado que reescribir; sí hay **fuentes de evidencia** que el plan debe conocer y no confundir con fuentes de datos.

| Fuente | Ruta / acceso | Qué prueba | Estado verificado |
|--------|---------------|------------|-------------------|
| Export del chat | `/Users/albertsalom/Downloads/ChatExport_NAS Monitor/messages.html` | Mensajes, fechas, remitentes, texto | ✅ legible, hash pinneado |
| `last-status` de copia | `/volume2/media-stack-appdata/backup/last-status` (creado en `media-backup.sh:150` y `:154`) | Último resultado de copia (`ok`/`failed`) | ✅ legible: `ok 2026-11-24T04:01:43+01:00` |
| `last-status.json` de security-monitor | `.../security-monitor/last-status.json` (creado en `main.py:263-267`) | Última pasada (`ok`, `failed_images`, `candidates`) | ✅ legible: `{"time": …, "ok": true, "images": 26, "candidates": 5, "security_updates": 0}` |
| `notified-updates.json` | `.../security-monitor/notified-updates.json` | CVEs ya notificados por imagen (dedup del monitor) | ✅ legible (16 KB); sin timestamps |
| `update-notifications.json` | `.../security-monitor/update-notifications.json` | Outbox del updater (mensajes pendientes) | ❌ `Permission denied` (root 600) |
| `notified.json` | `.../security-monitor/notified.json` | Histórico antiguo de paquetes | ✅ legible; no usar (pre-check de CVEs) |
| `failed-release.json` | `.../security-monitor/merged-releases/failed-release.json` (dir en `merged_updates.py:95`, escrito en `:385`) | Último release fallido y su configuración | ❌ `Permission denied` (dir 700 root) |
| Logs de Docker | `docker logs` en el NAS | Corroborar envíos recientes | ⚠️ cobertura corta: security-monitor desde 13 nov, WUD desde 8 nov, backup desde 1 oct, issue-automator desde 6 nov |
| Journal del sistema | `journalctl -u media-stack-*` | Histórico de ejecuciones | ❌ el usuario no está en `adm`/`systemd-journal`; solo el boot actual |
| Tabla `alerts` | PostgreSQL del hub, vía SSH o UI | Aperturas/recuperaciones de push | ❌ sin alias SSH al Oracle (D-03) |
| `/api/overview` | `src/app/api/[...path]/route.ts:279-290` | Últimos 100 `alerts` de un host | ⚠️ requiere sesión y hub accesible; muestra, no histórico |

**Conclusión de evidencia:** la ventana de 30–90 días **solo** la cubre el export. Todo lo demás es corroboración puntual o una columna condicionada.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Python | Script de auditoría | ✓ | 3.13.15 | — |
| `html.parser` (stdlib) | Parseo del export | ✓ | 3.13 | — |
| Node | Alternativa TS / no usada | ✓ | v24.22.3 | Python |
| pnpm | Ejecutar Vitest si se opta por TS | ✓ | 12.15.0 | Python unittest |
| `jq` | Inspección manual | ✓ | 1.7.1 | `python -m json.tool` |
| `bs4` / `lxml` | Parseo "cómodo" | ✗ | — | **No hacen falta**: `html.parser` |
| Docker local | Ver la BD del hub en local | ✓ (daemon) | — | El hub no corre en local (`docker ps` no lo lista) |
| SSH al NAS | Corroborar estado/logs | ✓ | clave `~/.ssh/NAS-HOME-SSH`, `alberba@100.124.98.51` | Sin él, solo export |
| Lectura de journal del NAS | Histórico de ejecuciones | ✗ | — | Docker logs (parcial) / state files |
| SSH al Oracle / `alerts` | Columna de push | ✗ | — | UI del hub (100 filas) o `—` |

**Missing dependencies with no fallback:**
- Ninguna que bloquee el entregable: el export y Python cubren AUDT-01, AUDT-03, AUDT-04 y la parte de Telegram de AUDT-02/AUDT-05.

**Missing dependencies with fallback:**
- Oracle/`alerts`: sin acceso, la columna de push se publica como `—` con nota de cobertura (D-03); el diseño ya la deja aditiva.
- Journal del NAS: sin `adm`, se usan los logs de Docker (cobertura corta) y los state files; no se promete histórico.

## Security Domain

`security_enforcement` está activo (`config.json` → `workflow.security_enforcement: true`, ASVS level 1). La fase no expone superficie nueva, pero **maneja datos personales y credenciales en texto** si se hace mal.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | No hay login ni sesión en esta fase |
| V3 Session Management | No | Ídem |
| V4 Access Control | No | Solo lectura local; el acceso al NAS es del operador |
| V5 Input Validation | **Sí** | El HTML del export es input no confiable: parser con profundidad, sin `eval`, sin shell, límites de tamaño, `unknown` en vez de adivinar |
| V6 Cryptography | No | No se cifra ni se firma nada; el `sha256` es integridad, no seguridad |
| V7 Error Handling | Sí | Un mensaje inclasificable no se descarta en silencio: va a `unknown` y se ve |
| V8 Data Protection | **Sí** | Datos personales (títulos, usuarios, CVE): NDJSON en `/tmp`, solo agregados al repo |

### Known Threat Patterns for este pipeline

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Fuga de cuerpos de mensajes al repo | Information Disclosure | NDJSON fuera del repo; fixture sintético; revisar `git diff` antes de commitear |
| Token del bot en logs o en el informe | Information Disclosure | El informe nunca imprime `TELEGRAM_BOT_TOKEN`; si se citan líneas de `media-backup.sh`, se cita la línea, no el valor |
| HTML malicioso en el export (script/atributo) | Tampering / XSS si se renderiza | `html.parser` no ejecuta nada; el informe se escribe en Markdown, no en HTML |
| Inyección de comandos al shell | Tampering | El script no llama a `subprocess` con datos del mensaje; si se usa `docker logs`, argumentos fijos |
| Path traversal en la ruta del export | Tampering | Ruta absoluta fijada por argumento y validada contra el hash esperado |
| Medición sesgada presentada como hecho | Repudiation | Etiqueta de fuente por cifra (`export`/`código`/`state`/`no medido`) y sección de cobertura |

## Validation Architecture

`workflow.nyquist_validation` está activo en `.planning/config.json` (valor `true`), así que la fase necesita una arquitectura de validación explícita. La dificultad es que el entregable es un **documento**; la solución es validar los **datos** que lo generan y afirmar invariantes, nunca prosa.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | **Python `unittest` (stdlib 3.13.15)** para la herramienta de auditoría; Vitest 5.1.0 sigue siendo el runner de la app y no se toca |
| Config file | none — `unittest` descubre por patrón; no hay `pytest.ini` ni `conftest.py` |
| Quick run command | `python3 -m unittest discover -s scripts/audit -p 'test_*.py' -v` |
| Full suite command | `python3 -m unittest discover -s scripts/audit -p 'test_*.py' && pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUDT-01 | El parser produce 148 filas, 146 del bot y 2 del operador; los 45 separadores no cuentan; los 58 `joined` heredan remitente | unit (fixture) | `python3 -m unittest discover -s scripts/audit -p 'test_telegram_export.py' -v` | ❌ Wave 0 |
| AUDT-01 | La suma por familia y por era es igual al total; cada era declara `inclusive_days` y `rate == messages/days` | unit (invariante) | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` | ❌ Wave 0 |
| AUDT-02 | Cada familia tiene `can_emit_recovery`; Telegram no inventa recuperaciones; el join devuelve los valores esperados sobre un fixture con pares conocidos y `—` sin `alerts`. Si el export pinneado está presente, un test opcional comprueba 14/12/13/1 y se **salta** (no falla) cuando no está | unit | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` | ❌ Wave 0 |
| AUDT-02 | Con filas sintéticas de `alerts`, `latency = telegram_at - alerts.at` y la recuperación sale de `resolvedAt` | unit (adapter) | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` | ❌ Wave 0 |
| AUDT-03 | El histograma tiene 24 cubos, suma el total menos `missing_time`, y una muestra de 23:30 sigue en el cubo 23 | unit | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` | ❌ Wave 0 |
| AUDT-03 | Top 3 determinista con desempate alfabético | unit | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` | ❌ Wave 0 |
| AUDT-04 | Toda clave del catálogo (12 del hub + familias de Telegram) tiene disposición `immediate`/`digest`/`silent`; no hay claves huérfanas ni emisores sin orden | unit (schema del mapa) | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` | ❌ Wave 0 (el mapa se produce en 01-03) |
| AUDT-05 | El objetivo existe, es numérico, es ≤ baseline E4 y el baseline recalculado es 1,25/día (o el que se justifique) | unit | `python3 -m unittest discover -s scripts/audit -p 'test_noise_audit.py' -v` | ❌ Wave 0 |
| AUDT-01…05 | Regenerar el informe con el mismo hash produce el mismo `01-AUDIT.json` | integración (reproducibilidad) | `python3 scripts/audit/noise_audit.py --check-repro` | ❌ Wave 0 |
| — | La prosa del informe (español, tablas) no se testea: se revisa a mano en `/gsd-verify-work` | manual-only (justificado) | — | — |

### Sampling Rate

- **Per task commit:** `python3 -m unittest discover -s scripts/audit -p 'test_*.py'` (≈1 s).
- **Per wave merge:** lo anterior + `pnpm test` (la fase no toca `src/`, pero el repo no debe romperse).
- **Phase gate:** suite completa verde y `01-AUDIT.json` regenerado dos veces con el mismo hash; después `/gsd-verify-work`.

### Wave 0 Gaps

- [ ] `scripts/audit/telegram_export.py` — parser con profundidad y normalización.
- [ ] `scripts/audit/noise_audit.py` — clasificador, agregados por era, histograma, duplicados, render.
- [ ] `scripts/audit/test_telegram_export.py` — cubre AUDT-01 (parser).
- [ ] `scripts/audit/test_noise_audit.py` — cubre AUDT-01…05 (agregados e invariantes).
- [ ] `scripts/audit/fixtures/telegram_export_sample.html` — fixture **sintético** con: separador de fecha, mensaje normal, `joined` sin `from_name`, `\n` literal, `<a href="tel:…">`, un mensaje de cada familia, y un mensaje desconocido.
- [ ] `package.json` — opcional: `"audit:noise": "python3 scripts/audit/noise_audit.py"` y `"test:audit": "python3 -m unittest discover -s scripts/audit -p 'test_*.py'"`. Si se añade, el CI puede cubrirlo sin cambiar el runner.
- [ ] No hace falta instalar framework: `unittest` ya está.

**Alternativa si el planner prefiere TS:** el parser tendría que ser un tokenizer propio (Node 24 no trae `DOMParser`) o una dependencia nueva; el coste/riesgo es mayor para el mismo resultado. La recomendación es Python.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Leer el chat a mano y "saber" que hay ruido | Export + script reproducible con hash | Esta fase | El número deja de ser una impresión; se puede defender y repetir |
| Promedio plano del periodo | Segmentación por eras de cambio | D-05 | El efecto de los commits del 16 oct y 3 nov se ve, no se diluye |
| "Mensajes" como única unidad | Eventos y mensajes (doble cifra) | D-07 | La reducción se explica por eventos; la percepción se mide en mensajes |
| Un solo canal implícito | Telegram y push medidos por separado | Esta fase | No se atribuye al hub el ruido de `media-stack` ni al revés |
| Latencia push↔Telegram asumida | Columna condicionada con SQL y CSV | D-03 | El informe se entrega completo aunque el Oracle no esté |

**Deprecated/outdated:**
- **Contar mensajes por día del calendario sin era:** oculta el pico de E2 y la meseta de E4.
- **Usar `notified.json` de security-monitor como historial de avisos:** es el formato antiguo de paquetes, anterior a la verificación por CVEs (`main.py:219-221` lo separa explícitamente).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | La hora del export es hora de pared `Europe/Madrid` | §Dataset Reality Check | El histograma se desplaza 1–2 h; los picos de las 06:00 se leen mal. Evidencia triple, pero el fichero no lo declara |
| A2 | Las firmas de texto son estables y únicas en toda la ventana | §Code Examples | Un cambio de plantilla de WUD o del updater manda mensajes a `unknown` y subestima una familia |
| A3 | Los 14 mensajes WUD con coincidencia (13 `manual:` + 1 actualización) son "el mismo pendiente avisado por dos sistemas" | §Measurement Model | Si en realidad son hechos distintos, se sobrecuenta el duplicado; el informe debe enseñar el mensaje y sus coincidencias, no solo el número |
| A4 | `issue-automator` y SMART quedan fuera del cutover de `media-stack` | §Emitter & Key Inventory | El mapa de AUDT-04 quedaría incompleto si el usuario quiere apagar también Seerr |
| A5 | El export contiene todo el tráfico de Telegram relevante (un solo chat, un solo bot) | §Dataset Reality Check | Si hubiera otro chat o bot, faltarían mensajes; el export solo prueba este chat |
| A6 | El acceso a `alerts` seguirá sin estar disponible durante la fase | §Columna de push | Si aparece, hay que rellenar la columna; el diseño ya lo permite, pero requiere tiempo |
| A7 | E4 (12 días) es una línea base suficiente para el objetivo | §Measurement Model | Un objetivo de ≤3/día calculado sobre 12 días puede ser demasiado estricto o demasiado laxo |
| A8 | Los dos mensajes SMART del 25 abr son el mismo hecho con dos codificaciones | §Dataset Reality Check | Contarlos como dos eventos sobrecuenta E1 en un evento (12,5 % de sus mensajes); el informe debe decidir y decirlo |

**If this table is empty:** no aplica; hay 8 supuestos y A1/A3/A7 son los que el usuario debería confirmar al leer el informe.

## Open Questions (RESOLVED)

Todas las preguntas abiertas de la investigación quedaron resueltas por las decisiones de los planes 01-01, 01-02 y 01-03.

1. **¿Qué denominador define el ritmo?**
   - What we know: los conteos 8/105/20/15 son exactos; 0,04 y 1,15 de CONTEXT no salen con días inclusivos (0,05 y 1,25).
   - **RESOLVED (01-01, 01-03):** se fija `inclusive_days` 156/36/10/12 en `01-AUDIT.json`, `rate = messages / inclusive_days`, E4 = 1,25/día y una nota de denominador explica la diferencia. AUDT-05 se apoya en E4 = 1,25/día.

2. **¿"Duplicado push + Telegram" significa entre canales o entre sistemas?**
   - What we know: el único solapamiento push/Telegram es la copia fallida; el duplicado frecuente es WUD ↔ security-monitor (ambos Telegram).
   - **RESOLVED (01-02):** se publican dos bloques separados, `duplicates.inter_system` (Telegram) y `duplicates.inter_channel` (push/Telegram), y nunca se suman en una sola cifra.

3. **¿Cómo se define "tiempo hasta reconocer"?**
   - What we know: hoy no existe evento de ack; los botones llegan en la fase 6.
   - **RESOLVED (01-03):** se define `median(sentAt -> ackAt)` por severidad con guardia p90 y se publica `—` como valor actual, porque el evento de ack no existe todavía.

4. **¿Se incluye `issue-automator` en el orden de apagado?**
   - What we know: 5 mensajes en toda la ventana, 0 en E4; es una función de Seerr, no del hub.
   - **RESOLVED (01-03):** queda fuera del cutover, anotado como "fuera de alcance, revisar en fase 8"; el SMART desconocido corre la misma suerte.

5. **¿Se commitea la herramienta de auditoría?**
   - What we know: el repo ya tiene `scripts/` y tests; sin script, el informe no es reproducible.
   - **RESOLVED (01-01):** se commitea `scripts/audit/` con fixture sintético; nunca se commitean el export HTML ni el NDJSON.

6. **¿Qué pasa si el Oracle aparece a mitad de fase?**
   - What we know: el diseño deja `push_*` a `null` y el render imprime `—`.
   - **RESOLVED (01-02, 01-03):** un CSV/consulta de 90 días alimenta el adaptador aditivo; la columna se rellena y se añade una nota de cobertura, sin cambiar las tablas de Telegram.

7. **¿Cómo se separa el efecto de WUD 9.8.0 (8 nov) del de los commits del 3 nov?**
   - What we know: ambos caen dentro de E3, con 6 días de diferencia.
   - **RESOLVED (01-03):** la tabla de tendencia separa E3a (3–7 nov) de E3b (8–12 nov) y marca los cuatro hitos temporales.

## Sources

### Primary (HIGH confidence)
- `/Users/albertsalom/Downloads/ChatExport_NAS Monitor/messages.html` — `sha256 fe32cd3a…fdbe74`, 76.936 bytes, 148 mensajes; estructura, conteos y horas verificados en esta sesión.
- `media-stack/stacks/monitoring/compose.yaml:3-27,78-96` — `security-monitor` (cron, `SECURITY_AUTO_UPDATE`, `TELEGRAM_*`) y WUD (`getwud/wud:9.8.0`, `major-only`, `ONDIGEST false`).
- `media-stack/stacks/monitoring/security-monitor/main.py:168-176,185-206,255-267` — `telegram()`, `digest()`, envío y `last-status.json`.
- `media-stack/stacks/monitoring/security-monitor/updater.py:297-300,302-309,315,329,376` — `notify()`, outbox, etiqueta, recuperación y mensaje de autoactualización.
- `media-stack/scripts/upgrade.sh:30,39-51` — `AT=04:30`, `notify()`, `Media Stack — …`, `die()`.
- `media-stack/scripts/auto-release.sh:1-6,108-110` — prepara el release; no envía Telegram.
- `media-stack/scripts/merged_updates.py:95-98,148-163,343,347,385` — estado en `merged-releases/`, outbox, mensajes aplicada/falló, `failed-release.json`.
- `media-stack/stacks/backup/media-backup.sh:16,137-157` — `alert()`, `finish()`, `last-status`, solo fallo.
- `media-stack/stacks/extras/issue-automator/main.py:134-150,314,405-411,446` — `send_telegram()`, incidencia y tests.
- `media-stack/docs/profiles.md:109-121,142-165` — política documentada de WUD, digest de seguridad y autoactualizaciones.
- `media-stack` commits `d6831af` (2026-11-03), `38061f0` (2026-11-03), `16d824e` (2026-10-16), `cc8d8a3` (2026-11-08, WUD 9.8.0) — verificados con `git log`.
- `nas-dashboard/src/lib/collector.ts:16-19,25-68,134-221` — `condition()`, debounce, claves, recuperación.
- `nas-dashboard/src/lib/maintenance-alerts.ts:69,89,112,137,179,226` — claves de mantenimiento y despliegues.
- `nas-dashboard/src/lib/push.ts:5-33` — `notify()` con `Promise.allSettled`, sin política ni persistencia.
- `nas-dashboard/src/lib/schema.ts:134-151` — columnas de `alerts`; `drizzle/0000_known_madame_hydra.sql:17-25` y `drizzle/0003_multi_host.sql:2`.
- `nas-dashboard/src/app/api/[...path]/route.ts:279-290` — últimos 100 `alerts` por host.
- `nas-dashboard/agent/maintenance.py:245-248` — el hub lee `appdata/backup/last-status`.
- `nas-dashboard/.planning/config.json` — `nyquist_validation: true`, `security_enforcement: true`.

### Secondary (MEDIUM confidence)
- `nas-dashboard/.planning/research/SUMMARY.md` §"La auditoría primero" — las siete cifras y las cuatro decisiones que desbloquea.
- `nas-dashboard/.planning/research/PITFALLS.md` pitfall 24 y checklist de emisores — "hub caído = silencio" y "no dejar el trigger de WUD activo".
- `nas-dashboard/.planning/codebase/CONCERNS.md:263-267` — severidad fija al crear y `disk-health` que no resuelve.
- `media-stack/docs/profiles.md` — comportamiento del trigger de WUD (la plantilla exacta es del binario, no del repo).

### Tertiary (LOW confidence)
- Semántica exacta de `WUD_TRIGGER_TELEGRAM_TELEGRAM_THRESHOLD=major-only` y de `semverDiff` para tags no SemVer: deducida de `docs/profiles.md:110-114` y del mensaje de commit `d6831af`; no verificada contra la imagen `getwud/wud:9.8.0` en ejecución.
- Que los dos mensajes SMART provienen de un emisor retirado: no hay código ni historial en ninguno de los dos repos; solo el texto.

## Metadata

**Confidence breakdown:**
- **Dataset y parser:** HIGH — estructura contada, hash pinneado, casos límite reproducidos (joined, service, `\n`, `tel:`, hora local).
- **Inventario de emisores y claves:** HIGH — cada fila cita archivo:línea leído en esta sesión y el mensaje se reproduce desde el código.
- **Métricas (eras, eventos, duplicados):** HIGH en los conteos; MEDIUM en la interpretación de los 14 mensajes WUD con coincidencia (A3) y en el denominador de E1/E4.
- **Columna de push:** LOW/MEDIUM — el esquema es correcto, pero no hay datos y `alerts` mide decisiones, no entregas.
- **Mapa final y objetivo:** MEDIUM — es una decisión de producto de 01-03, informada por estos datos; el objetivo ≤3/día sigue provisional.

**Research date:** 2026-11-24
**Valid until:** 2026-12-24 para el método y el catálogo de claves (30 días; el código de `media-stack` cambia). El dataset es inmutable: el informe vale mientras el hash `fe32cd3a…fdbe74` sea el mismo.
