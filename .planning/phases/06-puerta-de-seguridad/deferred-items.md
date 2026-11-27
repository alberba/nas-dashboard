## Deferred Items

- `pnpm lint` falla solo por los directorios de herramienta no versionados (`.opencode/`, `.agents/`, `.claude/`, `.codex/`, `.gsd/`), que ESLint recorre porque `eslint.config.mjs` no los ignora.
  status: open
  **What:** `pnpm lint` termina con 5570 errores y 988 avisos, todos en rutas que empiezan por `.`; `eslint src tests` sale 0. Es anterior a este plan y queda fuera de su alcance: esos directorios son herramienta local y no se versionan. Se corrige ignorándolos en `eslint.config.mjs` o lintando solo `src`, `tests`, `scripts` y `drizzle`.
