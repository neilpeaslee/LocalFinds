// Hand-written row types mirroring db/migrations/*.sql. The DDL is the source of
// truth; these are the typed read/write surface. No ORM. Dates are ISO 8601
// strings (the client registers timestamptz/timestamp -> ISO parsers); ids are
// numbers (int8 -> Number parser). SELECTs alias snake_case columns to these
// camelCase names (see the *_COLS constants in queries.ts).

export type SourceStatus = "active" | "paused" | "dead";
export type FindStatus = "new" | "shown" | "hidden" | "starred" | "provisional";
export type RunStatus = "running" | "success" | "capped" | "error";
export type FeedbackAction =
  | "thumbs_up"
  | "thumbs_down"
  | "star"
  | "unstar"
  | "hide"
  | "unhide";
export type FetchClass = "ok" | "blocked" | "truncated" | "error";

export interface Source {
  id: number;
  url: string;
  name: string | null;
  notesPath: string | null;
  icalUrl: string | null;
  status: SourceStatus;
  qualityScore: number | null;
  findsCount: number;
  lastFindAt: string | null;
  lastCheckedAt: string | null;
  addedBy: string;
  createdAt: string;
}

export interface Find {
  id: number;
  title: string;
  url: string | null;
  urlHash: string;
  summary: string | null;
  eventStart: string | null;
  eventEnd: string | null;
  expiresAt: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  status: FindStatus;
  agent: string;
  sourceId: number | null;
  tags: string[];
  score: number | null;
  type: string;
  placeOsmId: string | null;
}

export interface Feedback {
  id: number;
  findId: number;
  action: FeedbackAction;
  note: string | null;
  createdAt: string;
}

export interface Run {
  id: number;
  agent: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  itemsAdded: number;
  itemsUpdated: number;
  warnings: number;
  numTurns: number | null;
  costUsd: number | null;
  usageJson: string | null;
  sessionId: string | null;
  error: string | null;
}

export interface Fetch {
  id: number;
  runId: number | null;
  agent: string;
  host: string;
  url: string;
  method: string;
  status: number | null;
  klass: FetchClass;
  via: string;
  ts: string;
}

export interface PlaceAnnotation {
  osmId: string;
  statusOverride: "closed" | "unknown" | null;
  note: string | null;
  duplicateOf: string | null;
  addedBy: string;
  createdAt: string;
  updatedAt: string;
}

// Row of localfinds.places (osm_places ⋈ annotations). geom/point are NOT
// selected. status is the effective status (override wins over OSM presence).
export interface Place {
  osmId: string;
  name: string;
  kind: string | null;
  lat: number | null;
  lng: number | null;
  town: string | null;
  address: string | null;
  website: string | null;
  phone: string | null;
  brand: string | null;
  tags: string[]; // derived key=value[] from the jsonb tag set (C7)
  status: "active" | "closed" | "unknown";
  statusOverride: "closed" | "unknown" | null;
  annotationNote: string | null;
  duplicateOf: string | null;
}
