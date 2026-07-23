-- P2 identity: accounts + session tokens (spec 2026-07-22-p2-identity-auth-design.md).
-- The ONLY schema change of the identity phase — existing tables untouched.
-- citext is a trusted extension (PG13+): creatable by the DB owner, no superuser needed.
-- WITH SCHEMA public is load-bearing: without it the extension lands in the migration
-- role's "$user" schema (localfinds), which is off the app role's (localfinds_api)
-- search_path — Postgrex then sees typsend as "localfinds.citextsend" and can't match
-- its citext extension ("type citext can not be handled", hit on prod 2026-07-22;
-- fixed there via ALTER EXTENSION citext SET SCHEMA public).
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

CREATE TABLE localfinds.users (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email           citext NOT NULL UNIQUE,
    hashed_password text NOT NULL,
    role            text NOT NULL DEFAULT 'member'
                       CHECK (role IN ('member', 'steward')),
    inserted_at     timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE localfinds.users_tokens (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     bigint NOT NULL REFERENCES localfinds.users(id) ON DELETE CASCADE,
    token       bytea NOT NULL,
    context     text NOT NULL,
    inserted_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_tokens_context_token_idx
    ON localfinds.users_tokens (context, token);
CREATE INDEX users_tokens_user_idx ON localfinds.users_tokens (user_id);
