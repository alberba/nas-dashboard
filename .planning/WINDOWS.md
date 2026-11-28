---
schema_version: 1
open_count: 2
waived_count: 0
fixed_count: 1
total_count: 3
last_updated: 2026-11-28T10:07:36.476Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 05 | deviation | tests/migrations.test.ts |  | La comparación de columnas vivas usa el snapshot más reciente, no el de 0005 | fixed |  | 2026-11-26T13:40:51.724Z | 2026-11-26T13:41:08.879Z |
| 2 | 05 | deviation | tests/telegram-updates.test.ts |  | La prueba de 05-01 cuenta la fila propia de Por qué en el teclado editado | open |  | 2026-11-26T14:43:30.747Z |  |
| 3 | 08 | deviation | .planning/phases/08-cutover-de-media-stack-y-consolidaci-n/08-10-SUMMARY.md |  | PR #112 de media-stack (COPY --chmod=0644 de issue-automator) pendiente de integrar; el NAS depende de un chmod en caliente | open |  | 2026-11-28T10:07:36.476Z |  |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "05",
    "file": "tests/migrations.test.ts",
    "line": null,
    "description": "La comparación de columnas vivas usa el snapshot más reciente, no el de 0005",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-11-26T13:40:51.724Z",
    "resolved_at": "2026-11-26T13:41:08.879Z",
    "milestone": null
  },
  {
    "id": 2,
    "kind": "deviation",
    "phase": "05",
    "file": "tests/telegram-updates.test.ts",
    "line": null,
    "description": "La prueba de 05-01 cuenta la fila propia de Por qué en el teclado editado",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-11-26T14:43:30.747Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 3,
    "kind": "deviation",
    "phase": "08",
    "file": ".planning/phases/08-cutover-de-media-stack-y-consolidaci-n/08-10-SUMMARY.md",
    "line": null,
    "description": "PR #112 de media-stack (COPY --chmod=0644 de issue-automator) pendiente de integrar; el NAS depende de un chmod en caliente",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-11-28T10:07:36.476Z",
    "resolved_at": null,
    "milestone": null
  }
]
````
