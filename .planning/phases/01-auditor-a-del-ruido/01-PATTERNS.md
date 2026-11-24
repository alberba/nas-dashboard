# Phase 1: Auditoría del ruido - Pattern Map

**Mapped:** 2026-11-24
**Files analyzed:** 8 (5 nuevos de herramienta + 1 config modificado + 2 artefactos de salida)
**Analogs found:** 7 / 8

> Esta fase no escribe producto: los únicos ficheros nuevos viven en `scripts/audit/` y en el directorio de la fase. `src/` y `media-stack/` se **leen**, no se modifican. Los "análogos" de este documento son para copiar **estilo de módulo, runner y fixture**, no lógica de auditoría (esa no existe todavía).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `scripts/audit/telegram_export.py` | utility (parser) | file-I/O → transform | `agent/smart.py` | role-match |
| `scripts/audit/noise_audit.py` | utility (classifier + aggregator + CLI) | batch / transform | `agent/smart.py` + `scripts/configure.mjs` | role-match |
| `scripts/audit/test_telegram_export.py` | test | file-I/O + transform | `agent/test_smart.py` + `agent/test_files.py` | role-match |
| `scripts/audit/test_noise_audit.py` | test | transform / batch | `agent/test_smart.py` + `tests/maintenance-alerts.test.ts` | role-match |
| `scripts/audit/fixtures/telegram_export_sample.html` | fixture (static data) | file-I/O | `tests/host-fixtures.ts` | partial (no hay fixtures estáticos commiteados) |
| `package.json` (modified) | config | — | `package.json` (bloque `scripts` actual) | exact |
| `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.md` | documentation (informe) | transform (render) | `agent/METRICS.md` | role-match |
| `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.json` | data artifact | batch | — | no analog |

**Reglas de clasificación aplicadas:** todos los análogos citados están **git-tracked** (verificado con `git ls-files -- <path>`); no se cita ningún mirror gitignored. `media-stack` es solo lectura y no aporta análogos de código para el repo (sus tests son shell + Python inline, ver §Metadata).

---

## Pattern Assignments

### `scripts/audit/telegram_export.py` (utility, file-I/O → transform)

**Analog:** `agent/smart.py`

El repo ya tiene un parser puro de salida externa (JSON de `smartctl`) con el mismo reparto: constantes arriba, funciones `_helper` defensivas, función pública que devuelve `list[dict]`/`dict` y lanza `ValueError` cuando el input no tiene la forma esperada. Copiar esa forma; **no** existe ningún `HTMLParser` en el repo (`grep -rn "HTMLParser\|html.parser"` → 0 resultados), así que el cuerpo del parser es nuevo y sale de `01-RESEARCH.md` §Code Examples 1.

**Imports y docstring de módulo** (`agent/smart.py:1-5`):

```python
"""Read-only SMART health for the host's physical disks through smartctl."""
from __future__ import annotations

import json
import re
```

**Constantes y regex de validación arriba del módulo** (`agent/smart.py:15-18`):

```python
DEFAULT_REALLOCATED_THRESHOLD = 0

DEVICE_PATH = re.compile(r"^/dev/(sd[a-z]+|nvme\d+(?:n\d+)?)$")
DEVICE_TYPES = {"ata", "sat", "scsi", "nvme"}
```

Trasladado a la fase: `MESES = {...}` (mapa explícito, nunca `%B`), `EXPECTED_SHA256`, `MESSAGE_CLASSES`, `SERVICE_CLASS` como constantes de módulo (research reglas 1–10, `01-RESEARCH.md:344-355`). El `sha256` esperado es una constante, no un argumento opcional.

**Función de parseo pura que valida la forma y falla con `ValueError`** (`agent/smart.py:60-82`):

```python
def parse_scan(output):
    data = json.loads(output)
    devices = data.get("devices") if isinstance(data, dict) else None
    if not isinstance(devices, list):
        raise ValueError("smartctl no devolvió una lista de discos")
    result = []
    seen = set()
    for item in devices:
        if not isinstance(item, dict):
            continue
        path = item.get("name")
        if path in seen or _short_device(path) is None:
            continue
        seen.add(path)
        device_type = str(item.get("type") or "").lower()
        result.append(
            {
                "name": path,
                "type": device_type if device_type in DEVICE_TYPES else None,
                "kind": _kind(item),
            }
        )
    return result
```

Equivalente para la fase: `parse_export(path) -> list[dict]` que (a) lee UTF-8, (b) comprueba el hash y aborta con el hash esperado y el obtenido, (c) recorre con `HTMLParser` y devuelve una fila por `div.message.default.clearfix[.joined]` (research reglas 2–6). El contrato de "una fila por mensaje, `time=None` cuando falta la hora" va en el docstring, como aquí el contrato "solo discos válidos, deduplicados".

**Normalización de valores defensiva** (`agent/smart.py:21-37`):

```python
def _int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _text(value, limit):
    return value[:limit] if isinstance(value, str) and value.strip() else None
```

Trasladado: `sender`, `title`, `text` se recortan y se devuelven `None` si están vacíos, nunca se inventan. El equivalente del límite (`limit`) importa para no volcar cuerpos largos en el NDJSON.

**Manejo de error por elemento, sin abortar el lote** (`agent/smart.py:242-258`):

```python
                if not isinstance(payload, dict):
                    raise ValueError("smartctl no devolvió un objeto JSON")
                entry = describe(payload, scan_device)
                key = entry["serial"] or scan_device["name"]
                entry = classify(
                    entry,
                    payload,
                    self._previous.get(key),
                    self.reallocated_threshold,
                )
                if entry["reallocatedSectors"] is not None:
                    previous[key] = entry["reallocatedSectors"]
                result.append(entry)
            except (OSError, TypeError, ValueError):
                result.append(unknown(scan_device, "read_failed"))
        self._previous = previous
        return {"available": True, "devices": result}
```

Trasladado: un mensaje inclasificable **no se descarta**; entra en `family="unknown"` y el render lo muestra (research pitfall 12 / regla 9). El parser no debe hacer `try/except: pass`.

**Segundo análogo para el contrato de solo lectura:** `agent/updates.py:1-8` documenta en el docstring que solo lee y que la acción usa argumentos fijos validados:

```python
"""Container access links, image versions and Compose image updates.

The snapshot only reads Docker. The update action runs exactly one fixed
Compose invocation built from the container's own Compose labels; nothing in
the request becomes an argument except the validated container id.
"""
from __future__ import annotations
```

El script de auditoría no ejecuta comandos ni red; si en algún momento se cita `media-stack`, es lectura de fichero por ruta absoluta validada (research §Security Domain, mitigación de path traversal).

---

### `scripts/audit/noise_audit.py` (utility, batch/transform + CLI)

**Analog primario:** `agent/smart.py` (la función `classify` es el patrón de clasificación pura con salida "unknown" explícita).
**Analog secundario:** `scripts/configure.mjs` (convención de CLI del directorio `scripts/`).

**Clasificación por acumulación de señales, con estado neutro explícito** (`agent/smart.py:154-172`):

```python
def classify(entry, payload, previous, reallocated_threshold):
    if not _has_smart_data(payload):
        entry.update({"status": "unknown", "issues": ["smart_unavailable"]})
        return entry

    issues = []
    status = "ok"

    def note(level, issue):
        nonlocal status
        issues.append(issue)
        if level == "fail":
            status = "fail"
        elif status == "ok":
            status = "watch"

    smart_status = payload.get("smart_status")
    if isinstance(smart_status, dict) and smart_status.get("passed") is False:
        note("fail", "smart_failed")
```

Trasladado a `classify(text)` de la fase: la primera firma que casa gana (orden de `SIGNATURES`), se devuelve un `dict` plano con `family` y las claves de join (`container`, `target_tag`, `services`), y el fallback es `{"family": "unknown"}` — nunca una excepción por mensaje no clasificado. La lista de firmas sale de `01-RESEARCH.md:232-243` y `:747-783`; **no** se inventa aquí.

**Estado que no se pierde entre llamadas** (`agent/smart.py:245-258`): el `previous` del monitor es el mismo patrón que el `started` de `condition()` (ver §Read-Only Hub Sources); para el agregador, el equivalente es el NDJSON intermedio en `/tmp`, no memoria del proceso.

**Convención de CLI en `scripts/`** (`scripts/configure.mjs:1-30`):

```javascript
import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
...
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    ...
  },
});
if (!values.url || !values.nas)
  throw new Error(
    "Usage: node scripts/configure.mjs --url https://hub.example.com ...",
  );
```

Reglas que el planner debe copiar para `noise_audit.py`:
- Un único punto de entrada `main()` con `argparse` (el repo no usa `argparse` todavía; el equivalente conceptual es `parseArgs`): `--export`, `--out-md`, `--out-json`, `--check-repro`, `--alerts-csv` (opcional, D-03).
- Ruta del export **obligatoria y absoluta**; error de uso con la invocación correcta, como la línea 28-30.
- Negarse a sobrescribir salidas sin `--force` si ya existen, como `configure.mjs:31-36` se niega a pisar `.env`.
- Sin shebang y sin `process.exit()`; los scripts de `scripts/` son módulos que se invocan con un runner (`node ...`, ver `package.json:15-16`) y dejan que el error salga con traza.

**Punto de entrada mínimo de un script del repo** (`scripts/migrate.ts:1-8`):

```typescript
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/lib/db";
try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migraciones aplicadas");
} finally {
  await pool.end();
}
```

Para Python, el `try/finally` se traduce en `main()` que devuelve `int` y un `if __name__ == "__main__": raise SystemExit(main())` (el repo usa `unittest.main()` en tests, ver abajo). La salida final es **una** línea resumen (conteos), no un log por mensaje.

**Contrato de reproducibilidad (`--check-repro`):** leer el mismo export dos veces y comparar el JSON de agregados ordenado por clave, tal como `01-VALIDATION.md:34` exige. No es un patrón existente en el repo (no hay script con `--check`); tomarlo de `01-RESEARCH.md:943`.

**Render del informe:** ver `01-AUDIT.md` más abajo; el script no debe contener el texto del informe en español como constantes largas — solo etiquetas de columna y cabeceras (ver §Shared Patterns, "tests no acoplados al copy").

---

### `scripts/audit/test_telegram_export.py` (test, file-I/O + transform)

**Analog primario:** `agent/test_smart.py` (fixtures construidas con funciones y aserciones sobre estructura).
**Analog secundario:** `agent/test_files.py` (fixture en `tempfile.TemporaryDirectory`).

**Cabecera del test: imports planos + módulo bajo prueba** (`agent/test_smart.py:1-5`):

```python
import json
import unittest

import smart
```

Se importa el módulo hermano **sin paquete**: `unittest discover -s scripts/audit` añade ese directorio a `sys.path`, igual que `discover -s agent` hace hoy con `server`/`smart` (`package.json:14`). Por eso **no** se crea `scripts/audit/__init__.py` ni se usan imports relativos.

**Builder de fixture con parámetros por defecto y overrides** (`agent/test_smart.py:26-45`):

```python
def scan(*devices):
    return json.dumps(
        {
            "json_format_version": [1, 0],
            "smartctl": {
                "version": [7, 4],
                "svn_revision": "5530",
                "platform_info": "x86_64-linux-6.12.0",
                "build_info": "(local build)",
                "argv": ["smartctl", "--scan-open", "--json"],
                "exit_status": 0,
            },
            "devices": [
                {
                    "name": name,
                    "info_name": name,
                    "type": kind,
                    "protocol": "NVME" if kind == "nvme" else "ATA",
                }
                for name, kind in devices
            ],
        }
    )
```

Trasladado: el fixture HTML se construye con un helper `message(...)` / `joined(...)` / `service(date)` que devuelve fragmentos de markup, y el test compone el documento. Alternativa ya recomendada por research: leer `fixtures/telegram_export_sample.html` con `Path(__file__).parent / "fixtures" / ...`. Ambas son válidas; la segunda es la que fija `01-VALIDATION.md:61`.

**Fixture en directorio temporal cuando el input es un fichero** (`agent/test_files.py:9-22`):

```python
class FileBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "media"
        self.root.mkdir()
        self.old = server.ROOTS
        server.ROOTS = {"media": self.root}
        (self.root / "movie.mkv").write_bytes(b"test movie")

    def tearDown(self):
        server.ROOTS = self.old
        self.temp.cleanup()
```

Trasladado: el test del parser copia el fixture sintético a un `TemporaryDirectory` cuando necesita probar "hash incorrecto" o "fichero ausente", y restaura el estado global en `tearDown`. Nunca apunta al export real del operador.

**Aserciones sobre conteos y estructura, no sobre texto** (`agent/test_containers.py:18-40`):

```python
class ComposeMetadata(unittest.TestCase):
    def test_reports_the_compose_project_and_service_labels(self):
        result = server.container_stat(
            summary(
                {
                    "com.docker.compose.project": "media-stack",
                    ...
                }
            )
        )
        self.assertEqual(
            result["compose"], {"project": "media-stack", "service": "radarr"}
        )
```

Trasladado (AUDT-01): `self.assertEqual(len(rows), 3)`, `Counter(r["sender"] for r in rows)` == `{"bot": 2, "operator": 1}`, `self.assertEqual(rows[0]["text"], "...")` solo para el caso del `\n` literal y el `tel:`. Prohibido afirmar "el informe dice «WUD»" (`CODING_STANDARD.md:3-15`).

**Runner al final del fichero** (`agent/test_containers.py:96-97`):

```python
if __name__ == "__main__":
    unittest.main()
```

Todos los `agent/test_*.py` terminan igual; es el patrón a copiar literalmente.

---

### `scripts/audit/test_noise_audit.py` (test, transform/batch)

**Analog primario:** `agent/test_smart.py` (funciones puras + fixtures a mano).
**Analog secundario:** `tests/maintenance-alerts.test.ts` (builder con `overrides` y helper `signal()`), útil si el planner prefiere leer el estilo TS del repo.

**Builder de snapshot con overrides parciales** (`tests/maintenance-alerts.test.ts:10-14` y `:92-94`):

```typescript
function maintenance(
  overrides: Partial<MaintenanceSnapshot> = {},
): MaintenanceSnapshot {
  return {
    timestamp: 1_763_040_000,
    ...
```

```typescript
function signal(signals: AlertSignal[], key: string) {
  return signals.find((entry) => entry.key === key);
}
```

Trasladado a Python: un helper `row(**overrides)` que devuelve una fila normalizada completa y un helper `family(summary, name)` para localizar una familia en el resultado; evita repetir 8 claves por test y hace legible el invariante.

**Aserciones por invariante, no por valor aislado** (`tests/maintenance-alerts.test.ts:105-111`, patrón `toMatchObject`):

```typescript
    expect(failed).toMatchObject({ failing: true, severity: "critical" });

    const ok = signal(
      maintenanceAlertSignals(maintenance(), "NAS-HOME"),
      "backup-failed",
    );
    expect(ok).toMatchObject({ failing: false });
```

Trasladado a `unittest`: `assertEqual(signal["failing"], True)` / `assertIn("severity", signal)`. Los invariantes concretos que el planner debe escribir como tests están en `01-RESEARCH.md:838-847` y `01-VALIDATION.md:43-49`:

```python
assert sum(summary["by_family"].values()) + summary["operator"] == summary["total"]
assert sum(summary["by_era"][e]["messages"] for e in ("E1", "E2", "E3", "E4")) == summary["total"]
for e, data in summary["by_era"].items():
    assert data["messages"] / data["inclusive_days"] == data["rate"]
assert summary["wud"]["messages"] >= summary["wud"]["scan_passes"]
```

**Test opcional contra el export real que se salta, no falla** (`agent/test_files.py:44-45` es el patrón de skip condicional del repo):

```python
    @unittest.skipUnless(hasattr(ctypes.CDLL(None), "renameat2"), "Linux NAS operation")
    def test_restore_never_overwrites_existing_file(self):
```

Trasladado (AUDT-02): `@unittest.skipUnless(EXPORT.exists(), "export no disponible")` para la comprobación 14/12/13/1; el test obligatorio usa el fixture sintético. Nunca se commitea el HTML real (`CODING_STANDARD.md` + research pitfall 16).

---

### `scripts/audit/fixtures/telegram_export_sample.html` (fixture, file-I/O)

**Analog parcial:** `tests/host-fixtures.ts`

**Filosofía de fixture del repo: builder tipado, mínimo, con overrides** (`tests/host-fixtures.ts:1-8`):

```typescript
import type { DeploymentsSnapshot } from "@/lib/deployments";
import type { MaintenanceSnapshot } from "@/lib/maintenance";

/** A healthy instance maintenance snapshot, overridable per test. */
export function maintenanceSnapshot(
  overrides: Partial<MaintenanceSnapshot> = {},
): MaintenanceSnapshot {
```

**No existe ningún fixture estático commiteado** en el repo (`find tests agent -iname "*fixture*" -o -iname "*.html"` → solo `tests/host-fixtures.ts`). `media-stack` tampoco tiene `tests/fixtures/`: construye datos en el propio test (`media-stack/tests/lib.sh` + heredocs Python en `tempfile.TemporaryDirectory`). Por eso este fichero es **parcial**: el planner debe inventariarlo como primer fixture de datos estático y documentar en el test por qué existe (markup con las cinco trampas es más legible como HTML que como string Python).

**Contenido mínimo obligatorio** (research §Wave 0 Gaps, `01-RESEARCH.md:958`): separador `message service`, un `message default clearfix` normal, un `joined` sin `from_name`, un mensaje con `\n` literal, un `<a href="tel:...">`, un mensaje por familia y uno desconocido. Sin datos personales: títulos inventados, contenedores `demo-*`.

**Regla de estilo:** el fixture es la **entrada**; el test no afirma el HTML, afirma las filas que produce. Si el fixture crece, se parte por caso (`export_joined.html`, `export_unknown.html`) en vez de un documento gigante.

---

### `package.json` (config, modified)

**Analog:** el propio bloque actual (`package.json:6-17`):

```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "node --import ./scripts/eslint-typescript-api.mjs ./node_modules/eslint/bin/eslint.js",
    "typecheck": "tsc --noEmit --incremental false",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "test:agent": "python3 -m unittest discover -s agent -p 'test_*.py'",
    "db:migrate": "node --env-file-if-exists=.env.local --import tsx scripts/migrate.ts",
    "worker": "node --env-file-if-exists=.env.local --import tsx src/worker.ts"
  },
```

**Precedente exacto para el runner Python** (`package.json:14`): `test:agent` ya invoca `python3 -m unittest discover -s <dir> -p 'test_*.py'`. Por tanto el script nuevo es una línea, mismo verbo y mismo orden:

```json
"audit:noise": "python3 scripts/audit/noise_audit.py",
"test:audit": "python3 -m unittest discover -s scripts/audit -p 'test_*.py'"
```

**Convención de nombres:** `test:*` para runners (`test`, `test:e2e`, `test:agent`), `db:*` para operaciones de BD, verbo suelto para el resto (`build`, `worker`, `lint`). `audit:noise` sigue el patrón `dominio:acción` de `db:migrate`.

**Dónde se documenta:** `README.md:144-150` (bloque de §"Desarrollo y pruebas") lista los comandos en un bloque `sh`; si se añaden los dos scripts, se añaden ahí. `README.md:163` ya advierte que los tests Python necesitan `agent/requirements.txt`; la auditoría **no** añade dependencia (stdlib), y eso debe decirse en la misma sección para que nadie instale `bs4`.

**CI:** `.github/workflows/ci.yml:31-43` instala Python 3.14 y ejecuta `pnpm test:agent`; si el planner quiere cobertura del audit en CI, el paso es `pnpm test:audit` justo después, sin tocar el runner. No es requisito de la fase si `test:audit` se ejecuta en local; la decisión es del planner (research lo deja como opcional, `01-RESEARCH.md:959`).

---

### `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.md` (documentation, render)

**Analog:** `agent/METRICS.md`

**Forma del documento de referencia:** título en español, párrafo de contrato, tabla de campos con unidades y origen (`agent/METRICS.md:1-20`):

```markdown
# Métricas nativas del agente

`GET /metrics` es la instantánea que el hub guarda cada 5 o 30 segundos. No
depende de Beszel ni de otro servicio: CPU, memoria, red, discos, RAID,
temperaturas y contenedores salen del host y de la API de Docker. La ruta usa el
mismo `AGENT_TOKEN` y la misma lista de IP permitidas que el resto del agente.

El agente solo lee `/host/proc`, `/host/sys` y los montajes de solo lectura que
declara `agent/compose.yaml`. No escribe en el host ni publica rutas completas.

## Respuesta

Los campos anteriores se conservan. Se añaden:

| Campo | Unidades | Origen |
| --- | --- | --- |
| `system` | texto y bytes | Modelo de CPU, núcleos, hilos, sockets, arquitectura, kernel, SO y RAM total |
```

Copiar: (a) un párrafo inicial que diga **qué mide, con qué fuente y qué no mide**; (b) tablas con columna de origen/evidencia; (c) ningún cuerpo de mensaje completo. El informe de la fase debe mantener la **etiqueta de fuente por cifra** (`export`/`código`/`state`/`no medido`), que es la regla de honestidad de `01-RESEARCH.md:514`.

**Estructura concreta que el planner debe fijar** (de `01-RESEARCH.md` §Measurement Model, no inventada): ventana y hash → eras E1–E4 con `inclusive_days` → mensajes/día por emisor → eventos vs mensajes (WUD) → recuperaciones por canal → duplicados 14/12/13/1 → histograma 0–23 → top 3 claves → columna push (`—` si D-03) → mapa immediate/digest/silent (01-03) → orden de apagado → objetivo AUDT-05 → cobertura y supuestos A1–A8.

**Prohibición de copy en tests:** el `.md` no se testea; se revisa a mano (`01-VALIDATION.md:66-71`). El JSON del que sale sí.

---

### `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.json` (data artifact, batch)

**No analog.** El repo no commitea ningún JSON de agregados; el estado vive en PostgreSQL (`src/lib/schema.ts`) y los fixtures son código, no datos.

**Qué usar en su lugar:** el esquema del research, `01-RESEARCH.md:251-255` y `:263-267`:

```python
{"era": "E4", "from": "2026-11-13", "to": "2026-11-24",
 "inclusive_days": 12, "messages": 15, "rate": 1.25,
 "by_family": {"wud": 5, "security-update": 7, "release": 3}}
```

Campos `push_*` a `null` y `push_status="unavailable"` en todos los registros cuando D-03 no se resuelva. El JSON **no lleva cuerpos de mensajes**, solo agregados y claves (research §Security Domain, V8).

**Regla de formato:** `json.dump(..., ensure_ascii=False, indent=2, sort_keys=True)` para que `--check-repro` compare bytes; sin `datetime` serializado a mano (usar ISO-8601 string).

---

## Shared Patterns

### Runner y descubrimiento de tests Python

**Source:** `package.json:14`, `agent/test_containers.py:96-97`
**Apply to:** `test_telegram_export.py`, `test_noise_audit.py`

```json
"test:agent": "python3 -m unittest discover -s agent -p 'test_*.py'"
```

```python
if __name__ == "__main__":
    unittest.main()
```

Sin `pytest`, sin `conftest.py`, sin `__init__.py`. El nuevo directorio se descubre con `-s scripts/audit` y el patrón `test_*.py`. Los tests importan los módulos hermanos por nombre plano (`import noise_audit`), igual que `import server` / `import smart`.

### Fixtures: builder con overrides + tempdir, nunca datos reales

**Source:** `tests/host-fixtures.ts:4-8`, `agent/test_files.py:9-22`
**Apply to:** ambos tests y el fixture HTML

```typescript
/** A healthy instance maintenance snapshot, overridable per test. */
export function maintenanceSnapshot(
  overrides: Partial<MaintenanceSnapshot> = {},
): MaintenanceSnapshot {
```

El fixture sintético es la única entrada versionada; el export real (`/Users/albertsalom/Downloads/ChatExport_NAS Monitor/messages.html`) solo se usa en un test opcional con `skipUnless`. NDJSON y trace log van a `/tmp/noise-audit/` (research regla 10; `01-RESEARCH.md:355`).

### Tests afirman comportamiento, no copy

**Source:** `CODING_STANDARD.md:3-15`
**Apply to:** todos los tests de la fase

```markdown
A test goes _red_ only when the product stops working. Copy (headings, slogans, messages, labels) changes freely, so a test never depends on it.
```

Traducción operativa para la auditoría: se afirma `len(rows)`, `Counter(family)`, `rate == messages/days`, `set(keys)`, presencia de `push_status == "unavailable"`; **nunca** una frase en español del informe ni el título de un mensaje real.

### Convención de CLI y errores de uso

**Source:** `scripts/configure.mjs:5-36`, `scripts/reset-password.ts:7-13`
**Apply to:** `noise_audit.py`

```javascript
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    ...
  },
});
if (!values.url || !values.nas)
  throw new Error(
    "Usage: node scripts/configure.mjs --url https://hub.example.com --nas NAS_TAILSCALE_IP ...",
  );
```

```typescript
  if (process.stdin.isTTY)
    throw new Error(
      "Pass the new password through standard input, never as a command-line argument.",
    );
```

Patrón: argumento obligatorio → error con la invocación completa; entrada peligrosa (contraseña, ruta) → validación explícita antes de usarla; nunca `--yes` implícito. En Python: `parser.error(...)` de `argparse` produce el mismo contrato (mensaje + exit 2), y la ruta del export se resuelve con `Path(...).resolve()` y se compara contra el hash antes de parsear.

### Documentación de comandos en README, no en el script

**Source:** `README.md:144-150`
**Apply to:** los dos scripts nuevos, si se añaden

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:agent
pnpm build
```

La sección "Desarrollo y pruebas" es la única lista de comandos. El script no lleva comentario de uso largo: el docstring de módulo dice **qué lee y qué no escribe**, y el `--help` de `argparse`/`parseArgs` dice cómo se invoca.

---

## Read-Only Hub Sources the Audit Must Mirror

Estos ficheros **no se modifican**. Se leen para que el informe use las claves y columnas reales, no nombres inventados.

### `src/lib/collector.ts` — `condition()`, debounce y recuperación

**`started` en memoria y `scoped()`** (`src/lib/collector.ts:16-23`):

```typescript
const started = new Map<string, number>();
/** Snapshot-backed alerts are refreshed at most once a minute per host. */
const ALERT_SNAPSHOT_INTERVAL_MS = 60_000;
const alertSnapshotAt = new Map<string, number>();

function scoped(host: HostConfig, key: string) {
  return `${host.id}:${key}`;
}
```

**Apertura: inserta y luego notifica, fuera de transacción** (`src/lib/collector.ts:61-67`):

```typescript
  if (!started.has(scoped(host, key))) started.set(scoped(host, key), now);
  if (!open && now - started.get(scoped(host, key))! >= duration * 1000) {
    await db
      .insert(alerts)
      .values({ hostId: host.id, key, title, detail, severity });
    await notify(title, detail, scoped(host, key));
  }
```

**Recuperación: `resolvedAt` + push `Recuperado: ...` con tag `-resolved`** (`src/lib/collector.ts:46-59`):

```typescript
  if (!failing) {
    started.delete(scoped(host, key));
    if (open) {
      await db
        .update(alerts)
        .set({ resolvedAt: new Date(now) })
        .where(eq(alerts.id, open.id));
      await notify(
        "Recuperado: " + title,
        "La incidencia se ha resuelto.",
        scoped(host, key) + "-resolved",
      );
    }
    return;
  }
```

Consecuencias que el informe debe declarar: (1) la recuperación existe solo en push y su tag es `<host>:<key>-resolved`; (2) `notify()` va **después** del `INSERT`, así que una fila abierta sin push es posible; (3) el debounce vive en memoria y se pierde al reiniciar; (4) la fila abierta se busca por `(hostId, key, resolvedAt IS NULL)` sin índice único (research §B, `01-RESEARCH.md:425`).

**Claves y duraciones** (`src/lib/collector.ts:134-221`): `connection` (60 s, critical), `cpu`/`memory` (`settings.sustainedSeconds`), `disk` (0), `temperature` (30 s, critical), `container:<name>` (30 s), y los snapshots a 60 s. El mapa de la fase 2 debe usar **estas** claves, no las del export.

### `src/lib/maintenance-alerts.ts` — las 6 claves de mantenimiento/despliegue

**Contrato de señal** (`src/lib/maintenance-alerts.ts:11-17`):

```typescript
export type AlertSignal = {
  key: string;
  failing: boolean;
  title: string;
  detail: string;
  severity: AlertSeverity;
};
```

**Ejemplo de clave y severidad condicional** (`src/lib/maintenance-alerts.ts:62-75`):

```typescript
  if (
    !degraded.has("backup") &&
    record(backup) &&
    (backup.status === "ok" || backup.status === "failed")
  ) {
    const failed = backup.status === "failed";
    signals.push({
      key: "backup-failed",
      failing: failed,
      title: failed ? `Copia fallida en ${hostName}` : "Copia recuperada",
      detail: failed ? "La última copia registrada ha fallado." : "",
      severity: "critical",
    });
  }
```

**Clave de despliegue** (`src/lib/maintenance-alerts.ts:225-233`): `deploy-failed`, `critical`, con `release` en el detalle. Las otras cuatro son `disk-health` (89), `reboot-pending` (112), `stack-unit-failed` (137), `release-retained` (179) — total **12 claves reales** contando las 6 de `collector.ts` y las 6 de aquí (research tabla B, `01-RESEARCH.md:408-421`).

**Lección de diseño para el clasificador:** una sección ilegible **no cambia el estado** (`degraded` corta la señal). Traducido al informe: un mensaje que no casa con firma no se borra ni se fuerza a una familia; va a `unknown` y se muestra.

### `src/lib/push.ts` — no hay severidad, preferencias ni persistencia

(`src/lib/push.ts:6-33`):

```typescript
export async function notify(title: string, body: string, tag: string) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  ...
  await Promise.allSettled(
    entries.map(async (entry) => {
      try {
        await webpush.sendNotification(
          ...
        );
      } catch (error) {
        ...
      }
    }),
  );
}
```

El informe **no puede** llamar "push enviado" a lo que hay en `alerts`: `alerts` guarda la decisión (fila insertada), no la entrega, y `Promise.allSettled` se traga el fallo. Etiqueta obligatoria: "decisión de push" (research pitfall 13, `01-RESEARCH.md:651-655`).

### `src/lib/schema.ts` — columnas reales de `alerts`

(`src/lib/schema.ts:134-151`):

```typescript
export const alerts = pgTable(
  "alerts",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    hostId: text().notNull().default("nas-home"),
    key: text().notNull(),
    title: text().notNull(),
    detail: text().notNull(),
    severity: text().notNull(),
    at: timestamp().notNull().defaultNow(),
    resolvedAt: timestamp(),
  },
  (t) => [
    index("alerts_key_idx").on(t.key),
    index("alerts_at_idx").on(t.at),
    index("alerts_host_key_idx").on(t.hostId, t.key),
  ],
);
```

**No hay** `channel`, `deliveredAt`, `notifiedAt` ni `fingerprint`. La columna de push del informe se construye con `at` (UTC, `timestamp without time zone`) y `resolvedAt`; el SQL de referencia está en `01-RESEARCH.md:540-546` y usa comillas en las columnas camelCase (`"hostId"`, `"resolvedAt"`). El CSV de entrada, si aparece, tiene exactamente `hostId,key,severity,at,resolvedAt`.

### `src/lib/madrid-day.ts` — límites de día, no formateador de hora

(`src/lib/madrid-day.ts:1-12`):

```typescript
/** Europe/Madrid is the calendar used by the hub for "today". */
export const HUB_TIME_ZONE = "Europe/Madrid";

export type MadridDay = {
  /** Calendar date in Europe/Madrid, as YYYY-MM-DD. */
  date: string;
  /** First instant of the day, inclusive. */
  start: Date;
  /** First instant of the next day, exclusive. */
  end: Date;
  timeZone: typeof HUB_TIME_ZONE;
};
```

Uso correcto en la fase: **ninguno** para el histograma (la hora del export ya es local; research pitfall 6). Uso legítimo: convertir la fecha de pared del export a instante UTC para cruzarla con `alerts.at`, con `zoneinfo` en Python, no reutilizando el parser de offset (`madrid-day.ts:37-46`) que asume `GMT+HH:MM`. La recuperación de `resolvedAt` y la latencia se calculan sobre instantes, nunca restando 1 h "porque es Madrid".

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `.planning/phases/01-auditor-a-del-ruido/01-AUDIT.json` | data artifact | batch | El repo no versiona agregados JSON; el estado vive en PostgreSQL (`alerts`) y los fixtures son código. Usar el esquema de `01-RESEARCH.md:251-255` y `ensure_ascii=False, indent=2, sort_keys=True`. |

**Caveats de "no analog" que el planner debe conocer (no son ficheros, pero afectan a cómo se escriben):**

- **No hay `HTMLParser` ni parser HTML en el repo.** `grep -rn "HTMLParser\|html.parser"` → 0. El cuerpo de `telegram_export.py` es nuevo; el análogo de `agent/smart.py` solo aporta forma de módulo, validación y contrato de error.
- **`scripts/` solo contiene TS/MJS** (`configure.mjs`, `eslint-typescript-api.mjs`, `migrate.ts`, `reset-password.ts`). Un `.py` en `scripts/` es nuevo; el estilo Python se toma de `agent/` y la invocación de `package.json`.
- **No hay fixtures estáticos commiteados.** El primer HTML de fixture de la fase es nuevo; `tests/host-fixtures.ts` aporta la filosofía (mínimo + overrides), no el formato.
- **No hay script de auditoría ni agregador estadístico previo.** `grep -rln "audit" scripts agent src tests` → 0. No inventar un "análogo de agregador": usar el modelo de `01-RESEARCH.md` §Measurement Model.

---

## Metadata

**Analog search scope:** `agent/`, `scripts/`, `tests/`, `src/lib/`, `.github/workflows/`, `README.md`, `CODING_STANDARD.md`; `media-stack/tests/` y `media-stack/scripts/` solo lectura (no aportan análogos al repo, confirman que sus fixtures son inline).
**Files scanned:** 27 (lectura completa o dirigida; se paró a los 5 análogos fuertes por categoría).
**Pattern extraction date:** 2026-11-24
**Tracked-source gate:** verificado con `git ls-files --` para los 20 paths citados; todos tracked. No se cita ningún path de `.agents/`, `.claude/`, `.codex/`, `.opencode/` ni mirrors de capacidades.
**Constraint check:** `media-stack` no se modificó (solo `sed`/`git ls-files` de lectura); no se escribió código de producto; este PATTERNS.md es el único fichero creado por el mapper.
