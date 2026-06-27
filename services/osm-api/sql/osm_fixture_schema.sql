-- Minimal stand-in for the tables osm2pgsql produces with classic output +
-- --hstore-all. The view reads ONLY these three columns per table, so the
-- fixture only needs these three. (Track A's bring-up fidelity check confirms
-- the real osm2pgsql tables expose the same osm_id/tags/way columns.)
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS hstore;

CREATE TABLE planet_osm_point (
    osm_id bigint,
    tags   hstore,
    way    geometry(Point, 3857)
);

CREATE TABLE planet_osm_polygon (
    osm_id bigint,
    tags   hstore,
    way    geometry(Geometry, 3857)
);
