# Phase 6: Puerta de seguridad - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-27
**Phase:** 6-Puerta de seguridad
**Areas discussed:** Frontera de lo protegido, Límites de cuerpo y respuesta

---

## Frontera de lo protegido

**start de contenedores**

| Option | Description | Selected |
|--------|-------------|----------|
| start sin verificación | No pierde datos ni corta servicio | ✓ |
| start también protegido | Todo el ciclo de vida igual | |

**Archivos (trash, move, restore)**

| Option | Description | Selected |
|--------|-------------|----------|
| Solo lo irreversible | purge y empty-trash; trash/move/restore con sesión | ✓ |
| También move | move puede descolocar rutas de otros servicios | |
| Todas las mutaciones de archivos | Todo pide verificación | |

**Comandos de host**

| Option | Description | Selected |
|--------|-------------|----------|
| Todos salvo check-health | check-health solo lee | ✓ |
| Los 8, igual que la UI | Una sola regla | |
| Solo los que cambian el sistema | deploy-now, run-security, clean-images, reconnect-apps | |

**Declaración obligatoria**

| Option | Description | Selected |
|--------|-------------|----------|
| Toda mutación declara protegida o exenta | Una nueva sin entrada rompe el test | ✓ |
| Solo se listan las protegidas | Lista corta, puede olvidarse una nueva | |

---

## Límites de cuerpo y respuesta

**Límite de cuerpo**

| Option | Description | Selected |
|--------|-------------|----------|
| Uno global pequeño + excepciones | ~16 KB, 413 antes de parsear, topes explícitos por ruta | ✓ |
| Un único límite para todo | p. ej. 64 KB | |
| Tú decides | | |

**Alcance del tope de respuesta**

| Option | Description | Selected |
|--------|-------------|----------|
| Lo que el hub lee del agente | Sin tocar el agente Python | ✓ |
| Hub + recortes en el agente | Bajar tope de logs y paginar directorios | |
| Solo respuestas del hub al navegador | | |

**Al superar el tope**

| Option | Description | Selected |
|--------|-------------|----------|
| Error claro, sin datos parciales | Conserva lo último válido | ✓ |
| Truncar con aviso | Cortar en límite válido | |

**Registro del 413**

| Option | Description | Selected |
|--------|-------------|----------|
| Solo respuesta, sin registro | | ✓ |
| Log del servidor | Ruta y tamaño, sin cuerpo | |

---

## Claude's Discretion

- CSP y HSTS (forma, Report-Only, dónde se emite HSTS) — área no seleccionada.
- Fricción de la verificación (ventana de 5 min, UX del 403) — área no seleccionada.
- Valores exactos de los topes de respuesta.

## Deferred Ideas

- Bajar el tope de logs del agente y paginar directorios en `agent/`.
- Confirmar `purge` escribiendo el nombre del elemento.
