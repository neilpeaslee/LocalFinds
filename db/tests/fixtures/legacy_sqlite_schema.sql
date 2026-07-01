-- Legacy SQLite DDL derived from packages/db/drizzle/0000_absurd_lake.sql +
-- 0001_boring_red_shift.sql.  Used only in test_etl.py to build a fixture
-- source DB; never applied to Postgres.

CREATE TABLE IF NOT EXISTS businesses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    osm_id       TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    kind         TEXT,
    tags         TEXT NOT NULL DEFAULT '[]',
    address      TEXT,
    town         TEXT,
    lat          REAL,
    lng          REAL,
    website      TEXT,
    phone        TEXT,
    brand        TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    notes_path   TEXT,
    added_by     TEXT NOT NULL,
    discovered_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    duplicate_of TEXT
);

CREATE TABLE IF NOT EXISTS sources (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    url             TEXT NOT NULL UNIQUE,
    name            TEXT,
    notes_path      TEXT,
    ical_url        TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    quality_score   REAL,
    finds_count     INTEGER NOT NULL DEFAULT 0,
    last_find_at    TEXT,
    last_checked_at TEXT,
    added_by        TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent        TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    status       TEXT NOT NULL DEFAULT 'running',
    items_added  INTEGER NOT NULL DEFAULT 0,
    items_updated INTEGER NOT NULL DEFAULT 0,
    warnings     INTEGER NOT NULL DEFAULT 0,
    num_turns    INTEGER,
    cost_usd     REAL,
    usage_json   TEXT,
    session_id   TEXT,
    error        TEXT
);

CREATE TABLE IF NOT EXISTS finds (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    url          TEXT,
    url_hash     TEXT NOT NULL UNIQUE,
    summary      TEXT,
    event_start  TEXT,
    event_end    TEXT,
    expires_at   TEXT,
    published_at TEXT,
    discovered_at TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'new',
    agent        TEXT NOT NULL,
    source_id    INTEGER REFERENCES sources(id),
    tags         TEXT NOT NULL DEFAULT '[]',
    score        REAL,
    type         TEXT NOT NULL DEFAULT 'event',
    business_id  INTEGER REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    find_id    INTEGER NOT NULL REFERENCES finds(id),
    action     TEXT NOT NULL,
    note       TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fetches (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  INTEGER REFERENCES runs(id),
    agent   TEXT NOT NULL,
    host    TEXT NOT NULL,
    url     TEXT NOT NULL,
    method  TEXT NOT NULL DEFAULT 'GET',
    status  INTEGER,
    klass   TEXT NOT NULL,
    via     TEXT NOT NULL DEFAULT 'webfetch',
    ts      TEXT NOT NULL
);
