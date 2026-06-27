-- Two admin boundaries (an admin_level 8 "Rockland" town polygon, and an
-- overlapping level 7 "Knox County") + business features inside/outside.
-- Geometry is 3857 (web mercator). Rockland, ME is ~ -69.11, 44.10. hstore
-- values are built with hstore(text[], text[]) so spaces/colons/slashes in
-- values (e.g. "Rock City Coffee", "https://...") need no manual quoting.

-- admin_level 8 town: a square around Rockland
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(-100,
 hstore(ARRAY['boundary','admin_level','name'],
        ARRAY['administrative','8','Rockland']),
 ST_Transform(ST_MakeEnvelope(-69.20, 44.05, -69.05, 44.15, 4326), 3857));

-- admin_level 7 county: a larger square enclosing the town
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(-101,
 hstore(ARRAY['boundary','admin_level','name'],
        ARRAY['administrative','7','Knox County']),
 ST_Transform(ST_MakeEnvelope(-69.40, 43.90, -68.90, 44.30, 4326), 3857));

-- A node café inside Rockland, with cuisine + contact tags + a chain brand
INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
(1,
 hstore(
   ARRAY['amenity','name','cuisine','website','phone',
         'addr:housenumber','addr:street','addr:city','brand'],
   ARRAY['cafe','Rock City Coffee','coffee_shop;cafe','https://rockcity.example',
         '+1-207-555-0100','316','Main Street','Rockland','Rock City']),
 ST_Transform(ST_SetSRID(ST_MakePoint(-69.11, 44.10), 4326), 3857));

-- A way (positive id) shop polygon inside Rockland
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(2,
 hstore(ARRAY['shop','name'], ARRAY['supermarket','Hannaford']),
 ST_Transform(ST_MakeEnvelope(-69.115, 44.095, -69.112, 44.098, 4326), 3857));

-- A relation (negative id) museum polygon inside Rockland
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(-3,
 hstore(ARRAY['tourism','name'], ARRAY['museum','Farnsworth Art Museum']),
 ST_Transform(ST_MakeEnvelope(-69.108, 44.103, -69.106, 44.105, 4326), 3857));

-- An unnamed node (must be excluded by the view)
INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
(4,
 hstore(ARRAY['amenity'], ARRAY['bench']),
 ST_Transform(ST_SetSRID(ST_MakePoint(-69.11, 44.10), 4326), 3857));

-- A named node with NO business key (must be excluded by the view)
INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
(5,
 hstore(ARRAY['name','highway'], ARRAY['Some Street','residential']),
 ST_Transform(ST_SetSRID(ST_MakePoint(-69.11, 44.10), 4326), 3857));
