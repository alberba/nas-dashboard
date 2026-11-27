# Phase 7: Acciones verificadas desde Telegram - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-27
**Phase:** 07-acciones-verificadas-desde-telegram
**Areas discussed:** Acciones por tipo de aviso, Botones en el mensaje

---

## Acciones por tipo de aviso

| Option | Description | Selected |
|--------|-------------|----------|
| Arrancar y Reiniciar | Las dos que arreglan un contenedor caído | ✓ |
| Solo Reiniciar | Un único botón | |
| Arrancar, Reiniciar y Actualizar | Ciclo de vida sin borrar | |

| Option | Description | Selected |
|--------|-------------|----------|
| Todo pasa por el hub | Un solo camino; el hub aplica su manifiesto | ✓ |
| Pasa por el hub y siempre pide passkey | Más estricto, chat y hub dejan de coincidir | |

| Option | Description | Selected |
|--------|-------------|----------|
| backup-failed → Copia ahora | `backup-now` | ✓ |
| deploy-failed → Desplegar ahora | `deploy-now` | ✓ |
| reboot-pending → Reiniciar host | `reboot` | ✓ |
| Ninguno: solo contenedores | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Ninguna (services-down) | El agente no responde | ✓ |
| Comprobar salud | `check-health` exento | |

| Option | Description | Selected |
|--------|-------------|----------|
| Sigue valiendo y avisa | El intent vale aunque la incidencia se resuelva | ✓ |
| Se anula | Se invalida al resolverse | |

| Option | Description | Selected |
|--------|-------------|----------|
| Sí, desaparecen | Coherente con D-10 de la fase 5 | ✓ |
| Se quedan | | |

**User's choice:** las opciones recomendadas en todos los casos, más tres avisos que no son de contenedor con acción.

---

## Botones en el mensaje

| Option | Description | Selected |
|--------|-------------|----------|
| Fila propia en el mismo teclado | Un toque | |
| Detrás de «Acciones…» | Submenú con «Volver» | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| Botón url en el mismo aviso | Edición silenciosa, válido 5 min | ✓ |
| Mensaje aparte con el enlace | Respuesta citada | |

| Option | Description | Selected |
|--------|-------------|----------|
| El worker restaura el teclado | Sin enlaces muertos | ✓ |
| Se queda hasta la próxima edición | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Uno por aviso; con «Cancelar» | Nunca dos enlaces vivos | ✓ |
| Uno por aviso, sin cancelar | | |

**User's choice:** submenú «Acciones…»; para el resto, las opciones recomendadas.

---

## Claude's Discretion

- Pantalla del handoff (pasos de confirmación, login sin perder el fragmento, método de verificación según el guard existente).
- Resultado en Telegram tras ejecutar (edición del aviso; no reconoce por defecto).
- Endpoint, columnas de `operations`, tokens de los nuevos botones y barrido de los intents vencidos.

## Deferred Ideas

- Actualizar imagen, Detener y acciones para otras claves desde el chat.
- Ejecución directa con passkey reciente.
