-- LOCAL-DEV ONLY. Reproduces the prod osm_places SHAPE (db/migrations/0002+0005)
-- but sourced from snapshot tables (db:pull) instead of planet_osm_*. Keeps
-- osm_places a MATERIALIZED VIEW so the app's REFRESH path is unchanged.
-- Run AFTER migrations 0001 + 0004. Never run on prod.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS hstore;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Table-only copy of localfinds.custom_places from db/migrations/0005.
-- Keep in sync with 0005; the drift test (local-schema.test.ts) guards columns.
CREATE TABLE localfinds.custom_places (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text NOT NULL,
  category     text NOT NULL,
  housenumber  text,
  street       text,
  city         text,
  state        text NOT NULL DEFAULT 'ME',
  postcode     text,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  website      text,
  phone        text,
  source_url   text NOT NULL,
  added_by     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_places_category_key_chk CHECK (
    split_part(category, '=', 1) IN ('amenity','shop','tourism','office','craft','leisure')
    AND split_part(category, '=', 2) <> ''
  )
);

-- Snapshot of live public.osm_places OSM rows (osm_id NOT LIKE 'custom/%').
-- Column ORDER here MUST equal the db:pull SELECT and db:load \copy order.
CREATE TABLE public.osm_places_snapshot (
  osm_id   text PRIMARY KEY,
  name     text,
  kind     text,
  geom     geometry,
  point    geometry,
  tags     jsonb,
  address  text,
  town     text,
  website  text,
  phone    text,
  brand    text
);

-- Region admin boundaries (admin_level 7/8) for local town resolution of
-- custom places added locally. Column ORDER MUST equal db:pull / db:load.
CREATE TABLE public.localfinds_boundaries (
  osm_id bigint,
  tags   hstore,
  way    geometry
);
CREATE INDEX localfinds_boundaries_way_gist ON public.localfinds_boundaries USING gist (way);

-- osm_places = snapshot OSM rows UNION the custom_places branch. The custom
-- branch is verbatim from 0005 EXCEPT its town subquery reads
-- public.localfinds_boundaries instead of planet_osm_polygon.
CREATE MATERIALIZED VIEW public.osm_places AS
    SELECT
      osm_id, name, kind, geom, point,
      ST_Y(ST_Transform(point, 4326)) AS lat,
      ST_X(ST_Transform(point, 4326)) AS lng,
      tags, address, town, website, phone, brand
    FROM public.osm_places_snapshot
  UNION ALL
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
      f.geom, f.point,
      ST_Y(ST_Transform(f.point, 4326))                AS lat,
      ST_X(ST_Transform(f.point, 4326))                AS lng,
      hstore_to_jsonb(f.tags)                          AS tags,
      NULLIF(trim(concat_ws(', ',
          NULLIF(trim(concat_ws(' ',
              f.tags->'addr:housenumber', f.tags->'addr:street')), ''),
          f.tags->'addr:city')), '')                   AS address,
      (
        SELECT b.tags->'name'
        FROM public.localfinds_boundaries b
        WHERE b.tags->'boundary' = 'administrative'
          AND b.tags->'admin_level' IN ('7', '8')
          AND ST_Contains(b.way, f.point)
        ORDER BY b.tags->'admin_level' DESC
        LIMIT 1
      )                                                AS town,
      COALESCE(f.tags->'website', f.tags->'contact:website') AS website,
      COALESCE(f.tags->'phone',   f.tags->'contact:phone')   AS phone,
      f.tags->'brand'                                  AS brand
    FROM (
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
    ) f
WITH DATA;

-- Same indexes as 0002/0005 + the 0006 tags-index swap (unique osm_id REQUIRED
-- for REFRESH ... CONCURRENTLY). tags uses plain gin(tags) (jsonb_ops) to match
-- migration 0006 — serves both ? key-existence and @> value-match; the old
-- jsonb_path_ops variant could not serve the ? filter.
CREATE UNIQUE INDEX osm_places_osm_id_uidx ON public.osm_places (osm_id);
CREATE INDEX osm_places_town_idx  ON public.osm_places (lower(town));
CREATE INDEX osm_places_point_gist ON public.osm_places USING gist (point);
CREATE INDEX osm_places_geom_gist  ON public.osm_places USING gist (geom);
CREATE INDEX osm_places_tags_gin   ON public.osm_places USING gin (tags);
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
