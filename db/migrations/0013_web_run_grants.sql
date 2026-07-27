-- Web (Phoenix) read grants for UI port plan 4: the /agents console and the
-- per-run transcript.
--
-- SELECT is the entire grant. Phoenix performs no writes on this surface: the
-- Run buttons spawn a detached agent CLI, which writes to runs/run_events as
-- the separate `localfinds` role over its own connection, from the box .env.
--
-- Same guard and idempotence as 0008-0011: a no-op where localfinds_api does
-- not exist (local dev, the test database), and re-runnable everywhere else.
--
-- NOT added to scripts/dev/db-load.sh's hand-maintained list, deliberately:
-- that list exists for migrations whose objects a `DROP SCHEMA localfinds
-- CASCADE` destroys. This migration creates no objects — it only grants to a
-- role that does not exist locally, so it is already a no-op there.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'localfinds_api') THEN
    -- /agents console: run history, 30-day spend (plan 4)
    GRANT SELECT ON localfinds.runs TO localfinds_api;
    -- /agents/runs/:id transcript, and the live tail's incremental reads
    GRANT SELECT ON localfinds.run_events TO localfinds_api;
  END IF;
END
$$;
