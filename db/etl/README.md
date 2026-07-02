# LocalFinds SQLite → Postgres ETL

One-time migration that ports the legacy SQLite data into the SP1 Postgres schema.
Run it against a **copy** of the real `localfinds.db`; never against the original.

## Usage

```bash
cd /home/neil/Projects/LocalFinds/db
. .venv/bin/activate

# Make a copy first!
cp /path/to/real/localfinds.db /tmp/localfinds_migration.db

python -m etl.migrate_sqlite_to_pg \
    /tmp/localfinds_migration.db \
    "postgresql://user:pass@host:5432/gis"
```

The script prints per-table counts on completion.

## Pre-cutover checklist (SP6)

1. Run against the copy and record counts (`sources`, `finds`, `feedback`, `runs`,
   `fetches`, `place_annotations`).
2. Diff against counts from the live SQLite (`SELECT COUNT(*) FROM ...` on each table).
3. Spot-check a few rows (a lead's `place_osm_id`, a closed-business annotation).
4. Confirm no existing `localfinds.*` data in the target Postgres (fresh schema).
5. If all good, cut over: point the app at Postgres and retire the SQLite file.

## Mapping summary

| SQLite table | Postgres target | Notes |
|---|---|---|
| `sources` | `localfinds.sources` | New identity ids; URL is natural key |
| `runs` | `localfinds.runs` | New identity ids |
| `finds` | `localfinds.finds` | `source_id` remapped by URL; `business_id`→`place_osm_id` via `businesses.osm_id` |
| `feedback` | `localfinds.feedback` | `find_id` remapped by insertion order |
| `fetches` | `localfinds.fetches` | `run_id` remapped by insertion order |
| `businesses` (non-default) | `localfinds.place_annotations` | Facts discarded; status/notes/duplicate_of preserved |
| `businesses` (default/clean) | *(discarded)* | Facts come from `osm_places` matview |
| Lead finds with `business_id` | anchor row in `place_annotations` | Ensures FK satisfiable |
