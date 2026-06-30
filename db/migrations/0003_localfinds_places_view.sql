-- localfinds.places: the single source to query. Catalog facts (osm_places)
-- left-joined to the sparse LocalFinds annotation overlay. Reads (directory,
-- map, feed) target THIS view; tiering is still applied at render from
-- categories.json. status is the effective status (override wins over OSM presence).
CREATE VIEW localfinds.places AS
SELECT
    p.*,
    a.status_override,
    COALESCE(a.status_override, 'active') AS status,
    a.note                                AS annotation_note,
    a.duplicate_of
FROM osm_places p
LEFT JOIN localfinds.place_annotations a USING (osm_id);
