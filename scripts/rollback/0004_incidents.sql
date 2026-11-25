-- 0004 · incidents · reverse migration
--
-- Operational preconditions (the script refuses only what it can check):
--   1. Stop the app and the worker. An old process still reads "alerts"; a live
--      worker could enqueue or write work while the schema is half reverted.
--   2. Take a restorable copy of the database (or a schema dump). On a reverse
--      after real activity, archive notification_outbox and incident_events
--      first: this script drops them and cannot export their contents.
--   3. Run this file as one transaction against PostgreSQL 18, for example:
--        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/0004_incidents.sql
--      The script never touches another migration and aborts unless 0004 is the
--      last applied advance.
--
-- It restores only the synthetic migration closures (closedBy =
-- 'migration-dedup'): real closures before and after 0004 keep their
-- resolvedAt. Every row id and the identity sequence value are preserved, so a
-- later re-apply of 0004 neither repeats nor loses ids.

BEGIN;

DO $$
DECLARE
  last_applied bigint;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION
      'Reversa 0004 cancelada: no existe drizzle.__drizzle_migrations, así que no se puede verificar el journal';
  END IF;

  SELECT max(created_at) INTO last_applied
  FROM drizzle.__drizzle_migrations;

  IF last_applied IS DISTINCT FROM 1795591379120 THEN
    RAISE EXCEPTION
      'Reversa 0004 cancelada: 0004_incidents no es el último avance aplicado (último created_at: %)',
      last_applied;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM drizzle.__drizzle_migrations
    WHERE created_at = 1795591379120
  ) THEN
    RAISE EXCEPTION
      'Reversa 0004 cancelada: no consta la entrada aplicada de 0004_incidents';
  END IF;
END $$;

-- The partial index must go before the duplicate episodes can be open again.
DROP INDEX IF EXISTS "incidents_open_host_key_idx";

-- Only the synthetic closures made by the 0004 backfill are undone. Their
-- original value was NULL (they were open duplicates); real closures, both
-- historical and created after the migration, keep their resolvedAt.
UPDATE "incidents"
SET "resolvedAt" = "previousResolvedAt",
    "closedBy" = NULL,
    "previousResolvedAt" = NULL
WHERE "closedBy" = 'migration-dedup';

-- New tables and columns are removed only after the operator's restorable copy.
DROP TABLE IF EXISTS "notification_outbox";
DROP TABLE IF EXISTS "incident_events";
DROP INDEX IF EXISTS "incidents_fingerprint_idx";
ALTER TABLE "incidents"
  DROP COLUMN "previousResolvedAt",
  DROP COLUMN "closedBy",
  DROP COLUMN "origin",
  DROP COLUMN "seq",
  DROP COLUMN "fingerprint";

ALTER INDEX "incidents_key_idx" RENAME TO "alerts_key_idx";
ALTER INDEX "incidents_at_idx" RENAME TO "alerts_at_idx";
ALTER INDEX "incidents_host_key_idx" RENAME TO "alerts_host_key_idx";
ALTER TABLE "incidents" RENAME TO "alerts";
ALTER SEQUENCE "incidents_id_seq" RENAME TO "alerts_id_seq";

-- The journal entry is identified by the applied 0004 advance, never by row
-- position, so entries from other migrations are untouched.
DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1795591379120;

COMMIT;
