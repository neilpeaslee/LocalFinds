-- Web (Phoenix) read grants for the UI port (rung 3).
--
-- WHY THIS IS A MIGRATION AND NOT A RUNBOOK STEP:
-- The Phoenix app connects to production as a limited role (localfinds_api)
-- whose grants were provisioned per-table by the SP7 and P2 runbooks. Local and
-- test databases run as the OWNER role (localfinds) with full privileges, so a
-- missing production grant is completely invisible to the test suite. The
-- /sources cutover on 2026-07-24 shipped green tests and then returned
-- "ERROR 42501 (insufficient_privilege) permission denied for table sources"
-- the moment nginx routed the live page to Phoenix. Shipping grants as
-- versioned migrations makes each ported page's read access travel with its
-- code, so no future page can reach cutover missing its grant.
--
-- SAFE EVERYWHERE:
--   * The role does not exist on local/test databases -> the pg_roles guard
--     makes the whole block a no-op there.
--   * GRANT is idempotent -> re-running is harmless, including against
--     production where the sources grant was applied by hand during the
--     cutover.
--
-- Grants stay least-privilege (named table, SELECT only), matching the idiom
-- the SP7 and P2 runbooks established. As each page is ported, add the tables
-- that page reads -- here if it is still unapplied, otherwise in a new
-- migration.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'localfinds_api') THEN
    -- /sources list LiveView (rung 3, plan 1)
    GRANT SELECT ON localfinds.sources TO localfinds_api;
  END IF;
END
$$;
