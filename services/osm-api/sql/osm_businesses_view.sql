-- osm_businesses: projects imported OSM features into the exact row shape the
-- cartographer's upsert_businesses accepts. All business logic the cartographer
-- used to do client-side (kind, tag chips, address, town) lives here.
--
-- Reads only osm_id / tags (hstore) / way (geometry, 3857) — works against any
-- osm2pgsql import done with --hstore-all. Nodes come from planet_osm_point;
-- ways/relations (areas) from planet_osm_polygon. Geometry is web-mercator
-- (3857); lat/lng are transformed to 4326, containment math stays in 3857.
CREATE OR REPLACE VIEW osm_businesses AS
WITH src AS (
    -- nodes (way is already a point)
    SELECT
        'node/' || osm_id            AS osm_id,
        tags,
        way                          AS geom
    FROM planet_osm_point
    WHERE tags ? 'name'
      AND (tags ? 'amenity' OR tags ? 'shop' OR tags ? 'tourism'
           OR tags ? 'office' OR tags ? 'craft' OR tags ? 'leisure')
    UNION ALL
    -- ways / relations (areas). Negative osm_id in polygon = relation.
    SELECT
        CASE WHEN osm_id < 0
             THEN 'relation/' || (-osm_id)
             ELSE 'way/' || osm_id END AS osm_id,
        tags,
        ST_PointOnSurface(way)        AS geom
    FROM planet_osm_polygon
    WHERE tags ? 'name'
      AND (tags ? 'amenity' OR tags ? 'shop' OR tags ? 'tourism'
           OR tags ? 'office' OR tags ? 'craft' OR tags ? 'leisure')
)
SELECT
    s.osm_id,
    s.tags->'name'                                   AS name,
    ST_Y(ST_Transform(s.geom, 4326))                 AS lat,
    ST_X(ST_Transform(s.geom, 4326))                 AS lng,
    COALESCE(
        CASE WHEN s.tags ? 'amenity' THEN 'amenity=' || (s.tags->'amenity') END,
        CASE WHEN s.tags ? 'shop'    THEN 'shop='    || (s.tags->'shop')    END,
        CASE WHEN s.tags ? 'tourism' THEN 'tourism=' || (s.tags->'tourism') END,
        CASE WHEN s.tags ? 'office'  THEN 'office='  || (s.tags->'office')  END,
        CASE WHEN s.tags ? 'craft'   THEN 'craft='   || (s.tags->'craft')   END,
        CASE WHEN s.tags ? 'leisure' THEN 'leisure=' || (s.tags->'leisure') END
    )                                                AS kind,
    -- tag chips: business-key values + cuisine, split on ';', lowercased,
    -- distinct, capped at 12 — the server-side equivalent of the old tagList.
    COALESCE((
        SELECT array_agg(v)
        FROM (
            SELECT DISTINCT lower(trim(u)) AS v
            FROM unnest(string_to_array(
                concat_ws(';',
                    s.tags->'amenity', s.tags->'shop', s.tags->'tourism',
                    s.tags->'office',  s.tags->'craft', s.tags->'leisure',
                    s.tags->'cuisine'), ';')) AS u
            WHERE trim(u) <> ''
            LIMIT 12
        ) chips
    ), ARRAY[]::text[])                              AS tags,  -- never NULL
    NULLIF(trim(concat_ws(', ',
        NULLIF(trim(concat_ws(' ',
            s.tags->'addr:housenumber', s.tags->'addr:street')), ''),
        s.tags->'addr:city')), '')                   AS address,
    (
        SELECT b.tags->'name'
        FROM planet_osm_polygon b
        WHERE b.tags->'boundary' = 'administrative'
          AND b.tags->'admin_level' IN ('7', '8')
          AND ST_Contains(b.way, s.geom)
        ORDER BY b.tags->'admin_level' DESC   -- prefer level 8 (town) over 7
        LIMIT 1
    )                                                AS town,
    COALESCE(s.tags->'website', s.tags->'contact:website') AS website,
    COALESCE(s.tags->'phone',   s.tags->'contact:phone')   AS phone,
    s.tags->'brand'                                  AS brand,
    s.geom                                           AS geom
FROM src s;
