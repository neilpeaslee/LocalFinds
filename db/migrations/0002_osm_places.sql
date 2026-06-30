-- osm_places: the catalog of named OSM features in the region, projected into a
-- queryable shape. BASELINE scope = a faithful port of the old osm_businesses
-- view: the six commercial keys over points + polygons. The scope widening
-- (natural/historic + trails from planet_osm_line) is a deliberate follow-on.
-- Materialized so the per-row ST_Contains town lookup is computed once per
-- refresh; refreshed daily after osm2pgsql-replication with REFRESH ... CONCURRENTLY.
-- Explicit public schema: a deploy role's search_path must not silently misplace the matview.
CREATE MATERIALIZED VIEW public.osm_places AS
WITH feat AS (
    -- nodes (way is already a point; geom and point coincide)
    SELECT 'node/' || osm_id AS osm_id, tags, way AS geom, way AS point
    FROM planet_osm_point
    WHERE tags ? 'name'
      AND (tags ? 'amenity' OR tags ? 'shop' OR tags ? 'tourism'
           OR tags ? 'office' OR tags ? 'craft' OR tags ? 'leisure')
  UNION ALL
    -- ways/relations (areas). Negative osm_id = relation. osm2pgsql can split a
    -- multipolygon into several rows; collapse to one per osm_id (largest part).
    SELECT osm_id, tags, geom, ST_PointOnSurface(geom) AS point
    FROM (
        SELECT DISTINCT ON (osm_id)
            CASE WHEN osm_id < 0 THEN 'relation/' || (-osm_id) ELSE 'way/' || osm_id END AS osm_id,
            tags, way AS geom, ST_Area(way) AS area
        FROM planet_osm_polygon
        WHERE tags ? 'name'
          AND (tags ? 'amenity' OR tags ? 'shop' OR tags ? 'tourism'
               OR tags ? 'office' OR tags ? 'craft' OR tags ? 'leisure')
        ORDER BY osm_id, area DESC NULLS LAST
    ) poly
)
SELECT
    f.osm_id,
    f.tags->'name'                                   AS name,
    COALESCE(
        CASE WHEN f.tags ? 'amenity' THEN 'amenity=' || (f.tags->'amenity') END,
        CASE WHEN f.tags ? 'shop'    THEN 'shop='    || (f.tags->'shop')    END,
        CASE WHEN f.tags ? 'tourism' THEN 'tourism=' || (f.tags->'tourism') END,
        CASE WHEN f.tags ? 'office'  THEN 'office='  || (f.tags->'office')  END,
        CASE WHEN f.tags ? 'craft'   THEN 'craft='   || (f.tags->'craft')   END,
        CASE WHEN f.tags ? 'leisure' THEN 'leisure=' || (f.tags->'leisure') END
    )                                                AS kind,
    f.geom,
    f.point,
    ST_Y(ST_Transform(f.point, 4326))                AS lat,
    ST_X(ST_Transform(f.point, 4326))                AS lng,
    hstore_to_jsonb(f.tags)                          AS tags,
    NULLIF(trim(concat_ws(', ',
        NULLIF(trim(concat_ws(' ',
            f.tags->'addr:housenumber', f.tags->'addr:street')), ''),
        f.tags->'addr:city')), '')                   AS address,
    (
        SELECT b.tags->'name'
        FROM planet_osm_polygon b
        WHERE b.tags->'boundary' = 'administrative'
          AND b.tags->'admin_level' IN ('7', '8')
          AND ST_Contains(b.way, f.point)
        ORDER BY b.tags->'admin_level' DESC          -- prefer level 8 (town) over 7
        LIMIT 1
    )                                                AS town,
    COALESCE(f.tags->'website', f.tags->'contact:website') AS website,
    COALESCE(f.tags->'phone',   f.tags->'contact:phone')   AS phone,
    f.tags->'brand'                                  AS brand
FROM feat f
WITH DATA;

-- Unique key on osm_id: natural PK; REQUIRED for REFRESH ... CONCURRENTLY.
CREATE UNIQUE INDEX osm_places_osm_id_uidx ON public.osm_places (osm_id);
-- Primary access pattern: town filter lower(town) = lower($1).
CREATE INDEX osm_places_town_idx  ON public.osm_places (lower(town));
-- Spatial: representative point (pins/distance/clustering) + real shape (rendering).
CREATE INDEX osm_places_point_gist ON public.osm_places USING gist (point);
CREATE INDEX osm_places_geom_gist  ON public.osm_places USING gist (geom);
-- Tag filters over the full jsonb tag set.
CREATE INDEX osm_places_tags_gin   ON public.osm_places USING gin (tags jsonb_path_ops);
-- Name search (seeds the future search endpoint).
CREATE INDEX osm_places_name_trgm  ON public.osm_places USING gin (name gin_trgm_ops);
