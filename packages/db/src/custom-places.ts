import { execute, tx } from "./client";

// Writes for LocalFinds-added places (localfinds.custom_places) and the
// annotation overlay. Reads still go through localfinds.places.

export interface NewCustomPlaceInput {
  name: string;
  /** OSM key=value; key must be one the matview surfaces (CHECK-enforced). */
  category: string;
  housenumber?: string;
  street?: string;
  city: string;
  state?: string;
  postcode?: string;
  lat: number;
  lng: number;
  website?: string;
  phone?: string;
  /** Page where the business was confirmed — the honesty trail. */
  sourceUrl: string;
  addedBy: string;
}

export interface CustomPlaceResult {
  outcome: "created" | "duplicate";
  osmId: string;
}

// Same normalization on both sides of every name comparison.
const NORM = (expr: string) =>
  `btrim(lower(regexp_replace(${expr}, '[^a-zA-Z0-9]+', ' ', 'g')))`;

/**
 * Insert a custom place unless a same-named place already exists in the same
 * town or within ~100 m. Two checks because the matview lags: (1)
 * localfinds.places (OSM + refreshed custom rows), (2) custom_places directly
 * (rows added earlier in the SAME run, invisible until the post-run refresh).
 */
export async function insertCustomPlace(
  input: NewCustomPlaceInput,
): Promise<CustomPlaceResult> {
  return tx(async (c) => {
    const inPlaces = await c.query<{ osm_id: string }>(
      `SELECT osm_id FROM localfinds.places
       WHERE ${NORM("name")} = ${NORM("$1")}
         AND (lower(town) = lower($2)
              -- geography, not planar 3857: at ~44°N a Mercator "100" is only
              -- ~72 m of ground distance (scale 1/cos(lat)); both dedupe
              -- checks must apply the same true geodesic 100 m.
              OR ST_DWithin(ST_Transform(point, 4326)::geography,
                            ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 100))
       LIMIT 1`,
      [input.name, input.city, input.lng, input.lat],
    );
    if (inPlaces.rows[0]) return { outcome: "duplicate", osmId: inPlaces.rows[0].osm_id };

    const inCustom = await c.query<{ osm_id: string }>(
      `SELECT 'custom/' || id AS osm_id FROM localfinds.custom_places
       WHERE ${NORM("name")} = ${NORM("$1")}
         AND (lower(city) = lower($2)
              OR ST_DWithin(ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
                            ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 100))
       LIMIT 1`,
      [input.name, input.city, input.lng, input.lat],
    );
    if (inCustom.rows[0]) return { outcome: "duplicate", osmId: inCustom.rows[0].osm_id };

    const inserted = await c.query<{ id: number }>(
      `INSERT INTO localfinds.custom_places
         (name, category, housenumber, street, city, state, postcode,
          lat, lng, website, phone, source_url, added_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'ME'),$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        input.name, input.category,
        input.housenumber ?? null, input.street ?? null, input.city,
        input.state ?? null, input.postcode ?? null,
        input.lat, input.lng,
        input.website ?? null, input.phone ?? null,
        input.sourceUrl, input.addedBy,
      ],
    );
    return { outcome: "created", osmId: `custom/${inserted.rows[0].id}` };
  });
}

export interface PlaceAnnotationInput {
  osmId: string;
  note?: string;
  /** "clear" resets the override to NULL (place becomes active again). */
  statusOverride?: "closed" | "unknown" | "clear";
  duplicateOf?: string;
  addedBy: string;
}

export interface AnnotateResult {
  ok: boolean;
  reason?: string;
}

/**
 * Upsert the annotation overlay for an existing place. Only supplied fields
 * change; created_at is preserved. The osm_id must resolve — in
 * localfinds.places, or in custom_places directly (same-run additions the
 * matview hasn't seen yet).
 */
export async function upsertPlaceAnnotation(
  input: PlaceAnnotationInput,
): Promise<AnnotateResult> {
  const hasStatus = input.statusOverride !== undefined;
  const status = input.statusOverride === "clear" ? null : (input.statusOverride ?? null);
  return tx(async (c) => {
    const exists = await c.query(
      `SELECT 1 FROM localfinds.places WHERE osm_id = $1
       UNION ALL
       SELECT 1 FROM localfinds.custom_places WHERE 'custom/' || id = $1
       LIMIT 1`,
      [input.osmId],
    );
    if (exists.rowCount === 0) {
      return { ok: false, reason: `unknown osm_id: ${input.osmId}` };
    }
    await c.query(
      `INSERT INTO localfinds.place_annotations
         (osm_id, note, status_override, duplicate_of, added_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (osm_id) DO UPDATE SET
         note            = COALESCE($2, place_annotations.note),
         status_override = CASE WHEN $6 THEN $3 ELSE place_annotations.status_override END,
         duplicate_of    = COALESCE($4, place_annotations.duplicate_of),
         added_by        = $5,
         updated_at      = now()`,
      [input.osmId, input.note ?? null, status, input.duplicateOf ?? null, input.addedBy, hasStatus],
    );
    return { ok: true };
  });
}

/** Post-run (and post-test) matview refresh; CONCURRENTLY needs the unique osm_id index. */
export async function refreshOsmPlaces(): Promise<void> {
  await execute(`REFRESH MATERIALIZED VIEW CONCURRENTLY public.osm_places`);
}
