import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_ROOT = path.resolve(HERE, "../../../db");
const MIG = path.join(DB_ROOT, "migrations");
const FIX = path.join(DB_ROOT, "tests", "fixtures");
const LOCAL = path.join(DB_ROOT, "local", "osm-places-local.sql");
const read = (p: string) => readFileSync(p, "utf8");

let migC: StartedPostgreSqlContainer;
let locC: StartedPostgreSqlContainer;
let mig: pg.Client;
let loc: pg.Client;

async function connect(c: StartedPostgreSqlContainer) {
  const client = new pg.Client({ connectionString: c.getConnectionUri() });
  await client.connect();
  return client;
}

// Column signature (name + udt) of a relation, ordered by name for comparison.
async function cols(client: pg.Client, schema: string, table: string) {
  const r = await client.query(
    `SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name`,
    [schema, table],
  );
  return r.rows.map((x) => `${x.column_name}:${x.udt_name}`);
}

beforeAll(async () => {
  migC = await new PostgreSqlContainer("postgis/postgis:15-3.4").start();
  locC = await new PostgreSqlContainer("postgis/postgis:15-3.4").start();
  mig = await connect(migC);
  loc = await connect(locC);

  // migration-built reference DB: fixtures then all migrations, fixture order first
  await mig.query(read(path.join(FIX, "planet_osm.sql")));
  await mig.query(read(path.join(FIX, "seed_osm.sql")));
  for (const f of ["0001_localfinds_schema.sql", "0002_osm_places.sql",
                   "0003_localfinds_places_view.sql", "0004_run_events.sql",
                   "0005_custom_places.sql"]) {
    await mig.query(read(path.join(MIG, f)));
  }

  // local-built DB: planet-independent migrations then the local osm_places file
  await loc.query(read(path.join(MIG, "0001_localfinds_schema.sql")));
  await loc.query(read(path.join(MIG, "0004_run_events.sql")));
  await loc.query(read(LOCAL));
}, 180_000);

afterAll(async () => {
  await mig?.end(); await loc?.end();
  await migC?.stop(); await locC?.stop();
});

it("local osm_places column set matches the migration-built matview", async () => {
  expect(await cols(loc, "public", "osm_places")).toEqual(await cols(mig, "public", "osm_places"));
});

it("local custom_places matches the migration table", async () => {
  expect(await cols(loc, "localfinds", "custom_places")).toEqual(
    await cols(mig, "localfinds", "custom_places"));
});

it("local localfinds.places matches the migration view", async () => {
  expect(await cols(loc, "localfinds", "places")).toEqual(await cols(mig, "localfinds", "places"));
});

it("REFRESH MATERIALIZED VIEW CONCURRENTLY works on the local matview", async () => {
  // add a custom place with a boundary so town resolves, then refresh
  await loc.query(`
    INSERT INTO public.localfinds_boundaries (osm_id, tags, way) VALUES
      (1, 'boundary=>administrative, admin_level=>8, name=>Testville'::hstore,
       ST_Transform(ST_SetSRID(ST_MakeEnvelope(-69.10,44.00,-69.00,44.10),4326),3857));`);
  await loc.query(`
    INSERT INTO localfinds.custom_places
      (name, category, street, city, lat, lng, source_url, added_by)
    VALUES ('Acme Law','office=lawyer','1 Main St','Testville',44.05,-69.05,
            'https://example.test','test');`);
  await loc.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY public.osm_places;`);
  const r = await loc.query(
    `SELECT name, town, kind FROM public.osm_places WHERE osm_id LIKE 'custom/%'`);
  expect(r.rows[0].name).toBe("Acme Law");
  expect(r.rows[0].kind).toBe("office=lawyer");
  expect(r.rows[0].town).toBe("Testville");
});

it("snapshot rows surface through osm_places", async () => {
  await loc.query(`
    INSERT INTO public.osm_places_snapshot
      (osm_id,name,kind,geom,point,tags,address,town,website,phone,brand)
    VALUES ('node/42','Snap Cafe','amenity=cafe',
            ST_Transform(ST_SetSRID(ST_MakePoint(-69.05,44.05),4326),3857),
            ST_Transform(ST_SetSRID(ST_MakePoint(-69.05,44.05),4326),3857),
            '{"name":"Snap Cafe","amenity":"cafe"}'::jsonb,'1 Snap St','Testville',
            NULL,NULL,NULL);`);
  await loc.query(`REFRESH MATERIALIZED VIEW public.osm_places;`);
  const r = await loc.query(`SELECT town FROM public.osm_places WHERE osm_id='node/42'`);
  expect(r.rows[0].town).toBe("Testville");
});
