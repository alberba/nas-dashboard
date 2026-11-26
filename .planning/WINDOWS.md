---
schema_version: 1
open_count: 0
waived_count: 0
fixed_count: 1
total_count: 1
last_updated: 2026-11-26T13:41:08.879Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 05 | deviation | tests/migrations.test.ts |  | La comparación de columnas vivas usa el snapshot más reciente, no el de 0005 | fixed |  | 2026-11-26T13:40:51.724Z | 2026-11-26T13:41:08.879Z |

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
  }
]
````
