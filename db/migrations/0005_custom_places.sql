-- custom_places: system of record for places LocalFinds adds that are not in
-- OSM (concierge save_place; previously interim synthetic planet_osm_point
-- nodes at ids 9e14+). Surfaced through osm_places via a UNION ALL branch with
-- ids 'custom/<id>' so every downstream reader (localfinds.places, directory,
-- map, lead links) works unchanged. Survives a full osm2pgsql re-import — the
-- matview recreate just re-projects this table.
CREATE TABLE localfinds.custom_places (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text NOT NULL,
  category     text NOT NULL,          -- OSM key=value, e.g. 'office=lawyer'
  housenumber  text,
  street       text,
  city         text,
  state        text NOT NULL DEFAULT 'ME',
  postcode     text,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  website      text,
  phone        text,
  source_url   text NOT NULL,          -- page where the business was confirmed
  added_by     text NOT NULL,          -- agent name
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Only the six keys the matview surfaces; anything else would be invisible.
  CONSTRAINT custom_places_category_key_chk CHECK (
    split_part(category, '=', 1) IN ('amenity','shop','tourism','office','craft','leisure')
    AND split_part(category, '=', 2) <> ''
  )
);

-- Move the interim synthetic nodes (2026-07-02 legal-services scan) into
-- custom_places, remapping annotation + find links to the new custom/<n> ids.
-- Order inside the loop matters: finds FK-references place_annotations(osm_id),
-- so copy the annotation to the new id, repoint the finds, then drop the old row.
DO $$
DECLARE
  r record;
  new_id bigint;
  old_osm text;
  new_osm text;
BEGIN
  FOR r IN SELECT * FROM planet_osm_point WHERE osm_id >= 900000000000000 LOOP
    old_osm := 'node/' || r.osm_id;
    INSERT INTO localfinds.custom_places
      (name, category, housenumber, street, city, state, postcode,
       lat, lng, website, phone, source_url, added_by)
    VALUES (
      r.tags->'name',
      COALESCE(
        CASE WHEN r.tags ? 'amenity' THEN 'amenity=' || (r.tags->'amenity') END,
        CASE WHEN r.tags ? 'shop'    THEN 'shop='    || (r.tags->'shop')    END,
        CASE WHEN r.tags ? 'tourism' THEN 'tourism=' || (r.tags->'tourism') END,
        CASE WHEN r.tags ? 'office'  THEN 'office='  || (r.tags->'office')  END,
        CASE WHEN r.tags ? 'craft'   THEN 'craft='   || (r.tags->'craft')   END,
        CASE WHEN r.tags ? 'leisure' THEN 'leisure=' || (r.tags->'leisure') END),
      r.tags->'addr:housenumber',
      r.tags->'addr:street',
      r.tags->'addr:city',
      COALESCE(r.tags->'addr:state', 'ME'),
      r.tags->'addr:postcode',
      ST_Y(ST_Transform(r.way, 4326)),
      ST_X(ST_Transform(r.way, 4326)),
      COALESCE(r.tags->'website', r.tags->'contact:website'),
      COALESCE(r.tags->'phone',   r.tags->'contact:phone'),
      COALESCE(r.tags->'localfinds:source',
               'migrated: ' || COALESCE(r.tags->'localfinds:added', 'unknown')),
      'migration-0005'
    ) RETURNING id INTO new_id;
    new_osm := 'custom/' || new_id;

    INSERT INTO localfinds.place_annotations
      (osm_id, status_override, note, duplicate_of, added_by, created_at, updated_at)
    SELECT new_osm, status_override, note, duplicate_of, added_by, created_at, updated_at
    FROM localfinds.place_annotations WHERE osm_id = old_osm
    ON CONFLICT (osm_id) DO NOTHING;
    UPDATE localfinds.finds SET place_osm_id = new_osm WHERE place_osm_id = old_osm;
    DELETE FROM localfinds.place_annotations WHERE osm_id = old_osm;

    -- Best-effort cleanup of references in OTHER annotations.
    UPDATE localfinds.place_annotations
       SET duplicate_of = new_osm, updated_at = now()
     WHERE duplicate_of = old_osm;
    UPDATE localfinds.place_annotations
       SET note = replace(note, old_osm, new_osm), updated_at = now()
     WHERE note LIKE '%' || old_osm || '%';

    DELETE FROM planet_osm_point WHERE osm_id = r.osm_id;
  END LOOP;
END $$;

-- Recreate osm_places with the custom branch. localfinds.places depends on the
-- matview, so it drops first and is restored verbatim (0003) at the end.
DROP VIEW localfinds.places;
DROP MATERIALIZED VIEW public.osm_places;

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
  UNION ALL
    -- LocalFinds-added places (localfinds.custom_places): synthesize the same
    -- hstore tag shape so kind/address/town/website/phone derive identically.
    SELECT
      'custom/' || c.id AS osm_id,
      hstore(ARRAY['name', c.name,
                   split_part(c.category, '=', 1), split_part(c.category, '=', 2),
                   'addr:state', c.state,
                   'localfinds:source', c.source_url,
                   'localfinds:added', to_char(c.created_at, 'YYYY-MM-DD') || ' ' || c.added_by])
        || CASE WHEN c.housenumber IS NOT NULL THEN hstore('addr:housenumber', c.housenumber) ELSE ''::hstore END
        || CASE WHEN c.street      IS NOT NULL THEN hstore('addr:street',      c.street)      ELSE ''::hstore END
        || CASE WHEN c.city        IS NOT NULL THEN hstore('addr:city',        c.city)        ELSE ''::hstore END
        || CASE WHEN c.postcode    IS NOT NULL THEN hstore('addr:postcode',    c.postcode)    ELSE ''::hstore END
        || CASE WHEN c.website     IS NOT NULL THEN hstore('website',          c.website)     ELSE ''::hstore END
        || CASE WHEN c.phone       IS NOT NULL THEN hstore('phone',            c.phone)       ELSE ''::hstore END
        AS tags,
      ST_Transform(ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326), 3857) AS geom,
      ST_Transform(ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326), 3857) AS point
    FROM localfinds.custom_places c
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

-- Same indexes as 0002 (dropped with the matview; unique osm_id REQUIRED for
-- REFRESH ... CONCURRENTLY).
CREATE UNIQUE INDEX osm_places_osm_id_uidx ON public.osm_places (osm_id);
CREATE INDEX osm_places_town_idx  ON public.osm_places (lower(town));
CREATE INDEX osm_places_point_gist ON public.osm_places USING gist (point);
CREATE INDEX osm_places_geom_gist  ON public.osm_places USING gist (geom);
CREATE INDEX osm_places_tags_gin   ON public.osm_places USING gin (tags jsonb_path_ops);
CREATE INDEX osm_places_name_trgm  ON public.osm_places USING gin (name gin_trgm_ops);

-- localfinds.places restored verbatim from 0003.
CREATE VIEW localfinds.places AS
SELECT
    p.*,
    a.status_override,
    COALESCE(a.status_override, 'active') AS status,
    a.note                                AS annotation_note,
    a.duplicate_of
FROM public.osm_places p
LEFT JOIN localfinds.place_annotations a USING (osm_id);
