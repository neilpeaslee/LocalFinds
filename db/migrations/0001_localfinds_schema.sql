-- LocalFinds application schema. System of record for finds/sources/feedback/
-- runs/fetches + the sparse per-place annotation overlay. Co-located in the gis
-- DB so leads can JOIN the osm_places catalog. Extensions assumed present.
CREATE SCHEMA IF NOT EXISTS localfinds;

-- The LocalFinds-owned anchor for an OSM place. SPARSE: a row exists only when
-- there is an override, a note, a dedupe mark, or a lead pointing at it. osm_id
-- soft-links to osm_places.osm_id (a matview cannot be an FK target).
CREATE TABLE localfinds.place_annotations (
    osm_id          text PRIMARY KEY,
    status_override text CHECK (status_override IN ('closed', 'unknown')),
    note            text,
    duplicate_of    text,
    added_by        text NOT NULL DEFAULT 'system',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE localfinds.sources (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    url             text NOT NULL UNIQUE,
    name            text,
    notes_path      text,
    ical_url        text,
    status          text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'paused', 'dead')),
    quality_score   double precision,
    finds_count     integer NOT NULL DEFAULT 0,
    last_find_at    timestamptz,
    last_checked_at timestamptz,
    added_by        text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE localfinds.finds (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title         text NOT NULL,
    url           text,
    url_hash      text NOT NULL UNIQUE,
    summary       text,
    event_start   timestamptz,
    event_end     timestamptz,
    expires_at    timestamptz,
    published_at  timestamptz,
    discovered_at timestamptz NOT NULL DEFAULT now(),
    status        text NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'shown', 'hidden', 'starred', 'provisional')),
    agent         text NOT NULL,
    source_id     bigint REFERENCES localfinds.sources(id),
    tags          text[] NOT NULL DEFAULT '{}',
    score         double precision,
    type          text NOT NULL DEFAULT 'event',
    place_osm_id  text REFERENCES localfinds.place_annotations(osm_id)
);
CREATE INDEX finds_type_status_idx ON localfinds.finds (type, status);
CREATE INDEX finds_discovered_idx  ON localfinds.finds (discovered_at DESC);
CREATE INDEX finds_event_start_idx ON localfinds.finds (event_start);
CREATE INDEX finds_source_idx      ON localfinds.finds (source_id);
CREATE INDEX finds_place_idx       ON localfinds.finds (place_osm_id);
CREATE INDEX finds_tags_gin        ON localfinds.finds USING gin (tags);

CREATE TABLE localfinds.feedback (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    find_id    bigint NOT NULL REFERENCES localfinds.finds(id),
    action     text NOT NULL
                  CHECK (action IN ('thumbs_up', 'thumbs_down', 'star', 'unstar', 'hide', 'unhide')),
    note       text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_find_idx ON localfinds.feedback (find_id);

CREATE TABLE localfinds.runs (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent         text NOT NULL,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    status        text NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'success', 'capped', 'error')),
    items_added   integer NOT NULL DEFAULT 0,
    items_updated integer NOT NULL DEFAULT 0,
    warnings      integer NOT NULL DEFAULT 0,
    num_turns     integer,
    cost_usd      double precision,
    usage_json    jsonb,
    session_id    text,
    error         text
);
CREATE INDEX runs_agent_started_idx ON localfinds.runs (agent, started_at DESC);

CREATE TABLE localfinds.fetches (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id  bigint REFERENCES localfinds.runs(id),
    agent   text NOT NULL,
    host    text NOT NULL,
    url     text NOT NULL,
    method  text NOT NULL DEFAULT 'GET',
    status  integer,
    klass   text NOT NULL CHECK (klass IN ('ok', 'blocked', 'truncated', 'error')),
    via     text NOT NULL DEFAULT 'webfetch',
    ts      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fetches_host_idx ON localfinds.fetches (host);
CREATE INDEX fetches_run_idx  ON localfinds.fetches (run_id);
