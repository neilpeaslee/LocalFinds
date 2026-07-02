# LocalFinds Postgres schema

Canonical SQL migrations (the source of truth for the LocalFinds data layer)
and a testcontainers suite that proves they apply and behave. See the design
spec: `docs/superpowers/specs/2026-06-30-postgres-data-model-design.md`.

## Migrations

`migrations/NNNN_*.sql`, applied in lexical order against the `gis` database.
They assume the `postgis`, `hstore`, and `pg_trgm` extensions already exist
(Track A bring-up creates them on the box).

## Tests (Docker required)

    python3 -m venv .venv && . .venv/bin/activate
    pip install -e ".[dev]"
    ruff check .
    pytest          # spins a throwaway PostGIS via testcontainers
