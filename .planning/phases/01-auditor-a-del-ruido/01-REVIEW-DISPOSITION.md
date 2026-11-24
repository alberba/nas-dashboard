---
phase: 01
review: 01-REVIEW.md
titles: json
findings:
  - id: WR-01
    severity: warning
    disposition: fixed
    title: "The NDJSON with message bodies is world-readable and follows symlinks"
  - id: WR-02
    severity: warning
    disposition: fixed
    title: "--check-report verifies the embedded snapshot, not the aggregate"
  - id: WR-03
    severity: warning
    disposition: fixed
    title: "The report hardcodes the push unavailable narrative when --alerts-csv is supplied"
  - id: WR-04
    severity: warning
    disposition: fixed
    title: "Inventory recovery and cutover flags contradict the phase's own decisions"
  - id: WR-05
    severity: warning
    disposition: fixed
    title: "The parser drops messages without a .text child and inherits senders on non-joined rows"
  - id: WR-06
    severity: warning
    disposition: fixed
    title: "resolvedAt < at is accepted and published as a negative recovery latency"
  - id: IN-01
    severity: info
    disposition: fixed
    title: "The push/ack dash assertions do not pin the requirement, and one test asserts Spanish copy"
  - id: IN-02
    severity: info
    disposition: skipped
    title: "The Spanish report mixes decimal separators"
  - id: IN-03
    severity: info
    disposition: fixed
    title: "Time-less rows are joined as if their clock were midnight"
open: 0
total: 9
recorded: 2026-11-24T19:34:10Z
---

# Phase 01: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| WR-01 | warning | fixed | `write_ndjson` crea el directorio 0700, el fichero 0600 y abre con `O_NOFOLLOW`; test de permisos. `8ba6482` |
| WR-02 | warning | fixed | `check_report` reconstruye el modelo desde los agregados y compara también `report`; test de deriva con `dataset.messages=9999`. `8ba6482` |
| WR-03 | warning | fixed | El informe ramifica por `status`: hub medido publica aperturas/recuperaciones, la sección push pasa a `state` y la nota describe el CSV; test con el fixture. `8ba6482` |
| WR-04 | warning | fixed | `build_inventory` deriva `can_emit_recovery` de `RECOVERY_CAPABLE` e `in_cutover` de `build_shutdown_order`; test de consistencia. `8ba6482` |
| WR-05 | warning | fixed | El parser cierra la fila al abrir el siguiente mensaje y en `close()`, y solo hereda remitente en `joined`; tests de mensaje sin texto y sin remitente. `8ba6482` |
| WR-06 | warning | fixed | `load_alerts_csv` rechaza `resolvedAt < at` como fila inválida; test de fila omitida. `8ba6482` |
| IN-01 | info | fixed | La tabla de recuperaciones fija las celdas del hub y el ack con `None`/`—`; la prueba del denominador ya no depende de la palabra "inclusivos". `8ba6482` |
| IN-02 | info | skipped | Cosmético: los números son inequívocos y el JSON canónico usa punto; formatear todo el render con coma excede el contrato del plan y no cambia ninguna cifra |
| IN-03 | info | fixed | `_inter_system` y `join_push_windows` ignoran filas sin hora; test de WUD sin hora. `8ba6482` |
