-- Web (Phoenix) read grants for UI port plan 2: the places pages and the
-- source detail page.
--
-- Same guard and reasoning as 0008: the prod role (localfinds_api) is granted
-- per table, local/test databases run as the OWNER role and never have the
-- role at all, so a missing grant cannot fail a test — it fails live, at
-- cutover, with 42501 insufficient_privilege. Shipping the grant as a
-- migration makes each page's read access travel with its code.
--
-- WHAT IS AND IS NOT LISTED:
--   * localfinds.places is a VIEW over public.osm_places and
--     localfinds.place_annotations. It was created without security_invoker,
--     so it executes with its OWNER's privileges: granting the view alone is
--     sufficient, and granting the base tables would widen access for nothing.
--   * localfinds.finds is a real table read by /sources/:id.
--   * localfinds.sources was granted by 0008.
--
-- GRANT is idempotent, so re-running is harmless.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'localfinds_api') THEN
    -- /places list + /places/*osm_id detail (rung 3, plan 2)
    GRANT SELECT ON localfinds.places TO localfinds_api;
    -- /sources/:id detail (rung 3, plan 2)
    GRANT SELECT ON localfinds.finds TO localfinds_api;
  END IF;
END
$$;
