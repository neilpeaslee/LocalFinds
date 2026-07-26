-- Toggleable thumbs on /feed (UI port plan 3): clicking an already-active
-- thumbs_up/thumbs_down now records a RETRACTION rather than doing nothing.
-- localfinds.feedback is an append-only taste-signal log the agents read —
-- and the web role is deliberately INSERT-only on it (0010) — so "un-thumb"
-- cannot be a DELETE or UPDATE of the earlier row; it has to be a new row
-- that says "the prior thumb no longer applies." `thumbs_clear` is that row.
--
-- No pg_roles guard here, unlike 0008-0011: this changes the CHECK
-- constraint's shape, not a grant, so it must run everywhere the six-value
-- constraint exists — local dev, the test database rebuilt from
-- db/migrations/*.sql on every `mix test` (phoenix/scripts/prepare-test-db.sh),
-- and prod alike.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD, so a re-run (or a database
-- that already has the seven-value constraint) is a no-op rather than an
-- error. Every one of the original six values is preserved exactly.
ALTER TABLE localfinds.feedback DROP CONSTRAINT IF EXISTS feedback_action_check;
ALTER TABLE localfinds.feedback ADD CONSTRAINT feedback_action_check
  CHECK (action IN ('thumbs_up', 'thumbs_down', 'star', 'unstar', 'hide', 'unhide', 'thumbs_clear'));
