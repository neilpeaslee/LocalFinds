-- PL2: value-level tag filtering. The 0005 index was gin(tags jsonb_path_ops),
-- which serves @> containment but NOT the ? key-existence operator — so the
-- listPlaces key filter seq-scanned. Plain jsonb_ops serves BOTH ? and @>,
-- covering the bare-key filter and the new key=value value match. Same index
-- name so downstream refresh/rebuild is unaffected.
DROP INDEX IF EXISTS public.osm_places_tags_gin;
CREATE INDEX osm_places_tags_gin ON public.osm_places USING gin (tags);
