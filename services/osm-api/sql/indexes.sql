-- Applied to the gis DB during Track A import bring-up. Not needed for tests
-- (the fixture is tiny), but kept here so the index strategy is versioned.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN over the hstore tags (the view's key existence + value lookups).
CREATE INDEX IF NOT EXISTS planet_osm_point_tags_gin
    ON planet_osm_point USING gin (tags);
CREATE INDEX IF NOT EXISTS planet_osm_polygon_tags_gin
    ON planet_osm_polygon USING gin (tags);

-- Trigram on name (seeds the future /osm/search FTS endpoint).
CREATE INDEX IF NOT EXISTS planet_osm_point_name_trgm
    ON planet_osm_point USING gin ((tags->'name') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS planet_osm_polygon_name_trgm
    ON planet_osm_polygon USING gin ((tags->'name') gin_trgm_ops);

-- osm2pgsql already creates a GiST index on `way`; nothing to add here.
