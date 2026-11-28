-- 0010 · history_rollups · reverse migration
--
-- Operational preconditions (the script refuses only what it can check):
--   1. Stop the app and the worker. A live worker would keep writing to the
--      rollup tables while they are dropped, and the overview would answer 500
--      for 7d and 30d until the tables exist again.
--   2. Take a restorable copy of the database (or a schema dump) first.
--   3. Run this file as one transaction against PostgreSQL 18, for example:
--        psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/0010_history_rollups.sql
--      The script never touches another migration and aborts unless 0010 is the
--      last applied advance.
--   4. After the reverse the previous application version reads 7d and 30d
--      from `samples` again. That is only safe while the raw retention has not
--      been shortened (08-05): once samples older than 48 hours are deleted the
--      long ranges would come back empty. Reverse the retention first.
--
-- The rollup tables hold derived aggregates only; `samples` is untouched, so
-- nothing has to be exported before dropping them. Applying 0010 again and
-- running the backfill rebuilds them from `samples`.

BEGIN;

DO $$
DECLARE
  last_applied bigint;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION
      'Reversa 0010 cancelada: no existe drizzle.__drizzle_migrations, así que no se puede verificar el journal';
  END IF;

  SELECT max(created_at) INTO last_applied
  FROM drizzle.__drizzle_migrations;

  IF last_applied IS DISTINCT FROM 1795860558509 THEN
    RAISE EXCEPTION
      'Reversa 0010 cancelada: 0010_history_rollups no es el último avance aplicado (último created_at: %)',
      last_applied;
  END IF;
END $$;

-- The index and the primary keys go with their tables.
DROP TABLE IF EXISTS "container_rollups";
DROP TABLE IF EXISTS "sample_rollups";

-- The journal entry is identified by the applied 0010 advance (its `when` in
-- drizzle/meta/_journal.json), never by row position, so entries from other
-- migrations are untouched.
DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1795860558509;

COMMIT;
