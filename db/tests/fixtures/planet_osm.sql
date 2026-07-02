CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS hstore;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE planet_osm_point   (osm_id bigint, tags hstore, way geometry(Point, 3857));
CREATE TABLE planet_osm_polygon (osm_id bigint, tags hstore, way geometry(Geometry, 3857));
CREATE TABLE planet_osm_line    (osm_id bigint, tags hstore, way geometry(Geometry, 3857));
