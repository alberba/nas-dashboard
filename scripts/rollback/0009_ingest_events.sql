-- 0009 · ingest_events · reverse migration
--
-- Operational preconditions (the script refuses only what it can check):
--   1. Stop the app and the worker. A live process could write to
--      ingest_events while it is being dropped, and the ingest route would
--      answer 500 until the table exists again.
--   2. Take a restorable copy of the database (or a schema dump) first.
--   3. Run this file as one transaction against PostgreSQL 18, for example:
--        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/0009_ingest_events.sql
--      The script never touches another migration and aborts unless 0009 is the
--      last applied advance.
--
-- ingest_events only holds dedupe ids and body hashes, so there is no content to
-- export before dropping it. After the reverse, an external sender that retries
-- an old event is treated as new once 0009 is applied again.

BEGIN;

DO $$
DECLARE
  last_applied bigint;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION
      'Reversa 0009 cancelada: no existe drizzle.__drizzle_migrations, así que no se puede verificar el journal';
  END IF;

  SELECT max(created_at) INTO last_applied
  FROM drizzle.__drizzle_migrations;

  IF last_applied IS DISTINCT FROM 1795852819490 THEN
    RAISE EXCEPTION
      'Reversa 0009 cancelada: 0009_ingest_events no es el último avance aplicado (último created_at: %)',
      last_applied;
  END IF;
END $$;

-- The index goes with the table; the primary key too.
DROP TABLE IF EXISTS "ingest_events";

-- The journal entry is identified by the applied 0009 advance (its `when` in
-- drizzle/meta/_journal.json), never by row position, so entries from other
-- migrations are untouched.
DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1795852819490;

COMMIT;
