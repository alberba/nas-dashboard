---
phase: 08-cutover-de-media-stack-y-consolidaci-n
plan: "14"
subsystem: database
tags: [drizzle, postgres, migration, rollback, ingest, idempotency]

requires:
  - phase: 03-incidents
    provides: patron de reversa scripts/rollback/0004_incidents.sql y banco de pruebas de migraciones
provides:
  - tabla ingest_events (clave compuesta source+eventId) expuesta como ingestEvents en schema.ts
  - migracion aditiva 0009_ingest_events generada con drizzle-kit
  - reversa scripts/rollback/0009_ingest_events.sql guardada por el ultimo avance aplicado
affects: [08-01 ingest route, 08-05 poda de ingest_events]

actuals:
  tokens: 14000
  tasks: 2
  commits: 3

plan_head_before: c5744a8d418f3d1bc5a29a7ed43d9591f33f1f41
plan_head_after: 06e2f2b4fc53dfbf4cf7cb8996c1252626c12917

tech-stack:
  added: []
  patterns:
    - "Reversa con guarda por el when real del diario (created_at maximo), una transaccion"
    - "Ensayo de migracion sembrando la version anterior con migrateThrough y reaplicando con migrateAll"

key-files:
  created:
    - drizzle/0009_ingest_events.sql
    - drizzle/meta/0009_snapshot.json
    - scripts/rollback/0009_ingest_events.sql
  modified:
    - src/lib/schema.ts
    - drizzle/meta/_journal.json
    - tests/migrations.test.ts

key-decisions:
  - "P-39: ingest_events con PK (source, eventId), bodyHash NOT NULL, incidentId nulo sin FK, receivedAt sin zona con now() e indice por receivedAt"
  - "P-40: 0009 sale sola en el despliegue 1; la reversa copia el patron de 0004 y no exporta nada porque la tabla solo guarda ids y hashes"
  - "P-41: tracer (esquema + migracion real + lectura/escritura drizzle) y despues la reversa en TDD"

requirements-completed: [CONT-02]

coverage:
  - id: D1
    description: "Tabla ingest_events por migracion aditiva 0009 con clave compuesta, bodyHash no nulo e indice por receivedAt"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/migrations.test.ts#adds the idempotency table without rewriting history"
        status: pass
      - kind: integration
        ref: "tests/migrations.test.ts#applies 0009 to a new database and on top of 0008 with pnpm db:migrate"
        status: pass
    human_judgment: false
  - id: D2
    description: "Reversa de 0009 guardada por el ultimo avance y ensayada"
    requirement: CONT-02
    verification:
      - kind: integration
        ref: "tests/migrations.test.ts#rehearses 0009 → rollback → 0009 and leaves the rest untouched"
        status: pass
      - kind: integration
        ref: "tests/migrations.test.ts#refuses a journal where 0009 is not the last applied advance"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-11-28
status: complete
---

# Phase 08 Plan 14: Migracion 0009 ingest_events y reversa Summary

**Tabla de idempotencia `ingest_events` (PK compuesta `(source, eventId)`) por la migracion aditiva 0009 generada con drizzle-kit, con una reversa guardada por el ultimo avance aplicado y ambas ensayadas sobre una base sembrada en 0008.**

## Performance

- **Tasks:** 2 (tracer + TDD)
- **Files modified:** 6 (3 de ellos salida de drizzle-kit)

## Accomplishments

- `ingestEvents` en `src/lib/schema.ts` con la forma que consume 08-01.
- Migracion 0009 aditiva: una tabla nueva y un indice; las filas previas de `incidents` y `operations` quedan identicas, repetir el migrador no aplica nada y `scripts/migrate.ts` (`pnpm db:migrate`) llega al mismo estado desde 0008 y desde una base vacia.
- La clave compuesta rechaza el duplicado (SQL 23505 y `onConflictDoNothing().returning()` sin fila), el mismo `eventId` en otra fuente es otro evento, `bodyHash` nulo se rechaza (23502), `incidentId` admite nulo y no hay clave foranea.
- Reversa ensayada: deja la base sin la tabla y sin la fila 0009 del diario, el resto intacto; se reaplica con `migrateAll`; con un `created_at` posterior en el diario aborta con "no es el ultimo avance" y no cambia nada.

### SQL generado de 0009 (`drizzle/0009_ingest_events.sql`)

```sql
CREATE TABLE "ingest_events" (
	"source" text NOT NULL,
	"eventId" text NOT NULL,
	"bodyHash" text NOT NULL,
	"incidentId" integer,
	"receivedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_events_source_eventId_pk" PRIMARY KEY("source","eventId")
);
--> statement-breakpoint
CREATE INDEX "ingest_events_received_at_idx" ON "ingest_events" USING btree ("receivedAt");
```

Entrada del diario: `idx 9`, `tag 0009_ingest_events`, `when 1795852819490`. La guarda de la reversa usa ese valor; el ensayo comprueba que coincide con el diario.

## Task Commits

1. **Task 1: migracion 0009 y tabla ingest_events (tracer)** - `f1be354` (feat)
2. **Task 2: reversa de 0009 (TDD)** - RED `605e600` (test, fallaba por ENOENT de la reversa), GREEN `06e2f2b` (feat)

## Files Created/Modified

- `src/lib/schema.ts` - tabla `ingestEvents`
- `drizzle/0009_ingest_events.sql`, `drizzle/meta/0009_snapshot.json`, `drizzle/meta/_journal.json` - salida de `drizzle-kit generate --name ingest_events`, sin edicion a mano
- `scripts/rollback/0009_ingest_events.sql` - reversa guardada por el ultimo avance
- `tests/migrations.test.ts` - bloque "ingest events migration 0009" (4 pruebas)

## Decisions Made

P-39 (forma de la tabla), P-40 (reversa y orden de despliegue: 0009 sola en el despliegue 1) y P-41 (2 tareas, tracer mas reversa), tal como figuran en el plan.

## Deviations from Plan

None - plan executed exactly as written.

Verificacion final: `HUB_REQUIRE_TEST_DB=1 pnpm test tests/migrations.test.ts` (16 de 16), `pnpm typecheck` y `pnpm lint` sin errores. No hay stubs ni superficie de amenaza nueva fuera del modelo de amenazas del plan (T-08-34 y T-08-35 mitigadas por las pruebas).

## Self-Check: PASSED

- `src/lib/schema.ts`, `drizzle/0009_ingest_events.sql`, `drizzle/meta/0009_snapshot.json`, `scripts/rollback/0009_ingest_events.sql`: presentes.
- Commits `f1be354`, `605e600`, `06e2f2b` presentes en la rama.
