-- Web (Phoenix) read grant for UI port plan 3: the /feed page's thumb state.
--
-- Same guard and reasoning as 0008/0009/0010: the production role
-- (localfinds_api) is granted per table -- and per column, where a table
-- mixes write-model and read-model columns -- local and test databases run
-- as the OWNER role and never have the role at all, so a missing grant
-- cannot fail a test -- it fails live, at cutover, with 42501
-- insufficient_privilege.
--
-- Localfinds.Finds.feed_page/1 now left-joins localfinds.feedback (lateral,
-- one row per find) to surface each find's most recent thumbs_up/thumbs_down
-- as the `thumb` field, so a steward's click on 👍/👎 stays visible across a
-- reload. 0010 already granted SELECT (id) on this table, but only for the
-- RETURNING clause on insert -- it says nothing about reading find_id or
-- action back out. Column-level and least-privilege on purpose: the feed's
-- read path never touches `note` or `created_at`.
--
-- GRANT is idempotent, so re-running is harmless.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'localfinds_api') THEN
    -- /feed per-find thumb state, lateral join (rung 3, plan 3)
    GRANT SELECT (find_id, action) ON localfinds.feedback TO localfinds_api;
  END IF;
END
$$;
