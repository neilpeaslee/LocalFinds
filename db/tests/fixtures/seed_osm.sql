-- admin_level 8 town polygon enclosing the businesses below
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(-100,
 hstore(ARRAY['boundary','admin_level','name'], ARRAY['administrative','8','Rockland']),
 ST_Transform(ST_MakeEnvelope(-69.20, 44.05, -69.05, 44.15, 4326), 3857));

-- node cafe (amenity=cafe) with a rich tag set + a chain brand
INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
(1,
 hstore(ARRAY['amenity','name','cuisine','website','phone',
              'addr:housenumber','addr:street','addr:city','brand'],
        ARRAY['cafe','Rock City Coffee','coffee_shop','https://rockcity.example',
              '+1-207-555-0100','316','Main Street','Rockland','Rock City']),
 ST_Transform(ST_SetSRID(ST_MakePoint(-69.11, 44.10), 4326), 3857));

-- way supermarket polygon (positive id -> way/2)
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(2,
 hstore(ARRAY['shop','name'], ARRAY['supermarket','Hannaford']),
 ST_Transform(ST_MakeEnvelope(-69.115, 44.095, -69.112, 44.098, 4326), 3857));

-- relation museum polygon (negative id -> relation/3)
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(-3,
 hstore(ARRAY['tourism','name'], ARRAY['museum','Farnsworth Art Museum']),
 ST_Transform(ST_MakeEnvelope(-69.108, 44.103, -69.106, 44.105, 4326), 3857));

-- unnamed node (excluded: no name)
INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
(4,
 hstore(ARRAY['amenity'], ARRAY['bench']),
 ST_Transform(ST_SetSRID(ST_MakePoint(-69.11, 44.10), 4326), 3857));

-- named node, no business key (excluded)
INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
(5,
 hstore(ARRAY['name','highway'], ARRAY['Some Street','residential']),
 ST_Transform(ST_SetSRID(ST_MakePoint(-69.11, 44.10), 4326), 3857));

-- office/craft/leisure (the other three commercial keys) inside Rockland, so the
-- 6-key baseline predicate + kind COALESCE are exercised for ALL six keys.
INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
(10, hstore(ARRAY['office','name'], ARRAY['lawyer','Coastal Law']),
 ST_Transform(ST_SetSRID(ST_MakePoint(-69.112, 44.101), 4326), 3857));
INSERT INTO planet_osm_point (osm_id, tags, way) VALUES
(11, hstore(ARRAY['craft','name'], ARRAY['sawmill','Storer Lumber']),
 ST_Transform(ST_SetSRID(ST_MakePoint(-69.113, 44.102), 4326), 3857));
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(12, hstore(ARRAY['leisure','name'], ARRAY['park','Harbor Park']),
 ST_Transform(ST_MakeEnvelope(-69.109, 44.101, -69.107, 44.103, 4326), 3857));

-- A multipolygon RELATION that osm2pgsql split into TWO planet_osm_polygon rows
-- sharing one (negative) osm_id with different areas. The matview must collapse
-- them to ONE row (relation/6), keeping the larger part.
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(-6, hstore(ARRAY['tourism','name'], ARRAY['museum','Owls Head Light']),
 ST_Transform(ST_MakeEnvelope(-69.106, 44.101, -69.104, 44.103, 4326), 3857));   -- larger part
INSERT INTO planet_osm_polygon (osm_id, tags, way) VALUES
(-6, hstore(ARRAY['tourism','name'], ARRAY['museum','Owls Head Light']),
 ST_Transform(ST_MakeEnvelope(-69.104, 44.101, -69.1035, 44.1015, 4326), 3857)); -- smaller part
