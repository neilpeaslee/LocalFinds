import { normalizeTitle } from "./dedupe";

// Two OSM elements within this many metres, sharing a normalized name, are
// treated as the same real business. Tunable; 50m catches node-vs-way centroid
// offsets without merging genuinely distinct same-named neighbours.
export const DUP_RADIUS_M = 50;

// The fields the sweep reads. `Business` (from schema) is structurally
// assignable to this, so DB rows pass straight in without conversion.
export interface DedupeRow {
  id: number;
  osmId: string;
  name: string;
  kind: string | null;
  tags: string[];
  address: string | null;
  town: string | null;
  lat: number | null;
  lng: number | null;
  website: string | null;
  phone: string | null;
  brand: string | null;
  status: "active" | "closed" | "unknown";
  discoveredAt: string;
}

const EARTH_R = 6_371_000; // metres

export function metersBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

// More non-null facts = a better canonical candidate.
function richness(r: DedupeRow): number {
  let n = 0;
  if (r.website) n++;
  if (r.phone) n++;
  if (r.address) n++;
  if (r.kind) n++;
  if (r.brand) n++;
  if (r.tags.length > 0) n++;
  return n;
}

const STATUS_RANK: Record<DedupeRow["status"], number> = {
  active: 0,
  unknown: 1,
  closed: 2,
};

// Cluster rows that share a normalized name and fall within DUP_RADIUS_M of one
// another (transitive: A~B and B~C groups all three). Rows without coordinates
// are never grouped. Returns only clusters of 2+.
export function groupBusinessDuplicates(rows: DedupeRow[]): DedupeRow[][] {
  const byName = new Map<string, DedupeRow[]>();
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    const key = normalizeTitle(r.name);
    const bucket = byName.get(key);
    if (bucket) bucket.push(r);
    else byName.set(key, [r]);
  }

  const groups: DedupeRow[][] = [];
  for (const bucket of byName.values()) {
    if (bucket.length < 2) continue;

    // Union-find over the bucket, joining any pair within the radius.
    const parent = bucket.map((_, i) => i);
    const find = (i: number): number =>
      parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const d = metersBetween(
          { lat: bucket[i].lat as number, lng: bucket[i].lng as number },
          { lat: bucket[j].lat as number, lng: bucket[j].lng as number },
        );
        if (d <= DUP_RADIUS_M) parent[find(i)] = find(j);
      }
    }

    const clusters = new Map<number, DedupeRow[]>();
    bucket.forEach((r, i) => {
      const root = find(i);
      const cluster = clusters.get(root);
      if (cluster) cluster.push(r);
      else clusters.set(root, [r]);
    });
    for (const cluster of clusters.values()) {
      if (cluster.length >= 2) groups.push(cluster);
    }
  }
  return groups;
}

// The survivor of a duplicate group: active first (the live record should
// represent the place), then richest, then oldest, then lowest id.
export function chooseCanonical(group: DedupeRow[]): DedupeRow {
  return [...group].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      richness(b) - richness(a) ||
      a.discoveredAt.localeCompare(b.discoveredAt) ||
      a.id - b.id,
  )[0];
}

const MERGE_FIELDS = [
  "website",
  "phone",
  "address",
  "kind",
  "brand",
  "town",
] as const;

// Fill the canonical's empty fields from the other group members (richest
// first). Never overwrites an existing canonical value; tags are filled, not
// unioned. Returns only the fields that should be updated.
export function mergeFacts(
  canonical: DedupeRow,
  others: DedupeRow[],
): Partial<DedupeRow> {
  const ranked = [...others].sort(
    (a, b) =>
      richness(b) - richness(a) ||
      a.discoveredAt.localeCompare(b.discoveredAt) ||
      a.id - b.id,
  );
  const out: Record<string, unknown> = {};
  for (const field of MERGE_FIELDS) {
    if (canonical[field]) continue;
    const donor = ranked.find((r) => r[field]);
    if (donor) out[field] = donor[field];
  }
  if (canonical.tags.length === 0) {
    const donor = ranked.find((r) => r.tags.length > 0);
    if (donor) out.tags = donor.tags;
  }
  return out as Partial<DedupeRow>;
}
