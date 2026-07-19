import pg from "pg";

// Global type parsers — registered once at module load, before any pool exists.
// int8 (OID 20) -> Number: all identity ids are far below MAX_SAFE_INTEGER (C1).
pg.types.setTypeParser(20, (v: string | null) => (v === null ? null : Number(v)));
// timestamptz (1184) / timestamp (1114) -> ISO-8601 string, the app's date contract (C2).
const toIso = (v: string | null) => (v === null ? null : new Date(v).toISOString());
pg.types.setTypeParser(1184, toIso);
pg.types.setTypeParser(1114, toIso);

// Read a positive-integer pool tuning knob from the environment, falling back to
// `fallback` when unset/blank/non-numeric. Every value below is overridable in
// prod (via .env.production) without a code change.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Pool resilience defaults. The failure they prevent (prod outage 2026-07-19):
// a transient Postgres blip dropped every connection; with pg's default
// `connectionTimeoutMillis: 0` (wait forever), new requests blocked
// indefinitely acquiring a connection, stacked in the accept queue, and wedged
// the Next process — "online" in pm2 but serving nothing until a manual
// restart. Bounding acquisition makes a blip degrade to fast 5xx that recover
// on their own once PG returns, instead of a hung process.
//
// NOT set here: a global `statement_timeout`. It would be a second stuck-query
// guard, but osm_places is refreshed via REFRESH MATERIALIZED VIEW CONCURRENTLY
// (custom-places.ts), which cannot run inside a transaction and would need a
// per-statement exemption to stay safe. Deliberately left as a separate follow-up.
export const POOL_DEFAULTS = {
  /** Max time to wait for a connection from the pool before failing (was ∞). */
  connectionTimeoutMillis: 10_000,
  /** Reap a connection after this long idle, so dead sockets don't linger. */
  idleTimeoutMillis: 30_000,
  /** Ceiling on concurrent connections (pg's own default, made explicit). */
  max: 10,
  /** Recycle a connection after this many checkouts, rotating out half-dead ones. */
  maxUses: 7_500,
  /** TCP keepalive so the OS surfaces a dead peer instead of a silent hang. */
  keepAliveInitialDelayMillis: 10_000,
} as const;

function createPool(): pg.Pool {
  const connectionString = process.env.LOCALFINDS_DATABASE_URL;
  if (!connectionString) throw new Error("LOCALFINDS_DATABASE_URL is not set");
  const p = new pg.Pool({
    connectionString,
    // See POOL_DEFAULTS — bounds every wait so a Postgres blip can't wedge the
    // process. Each knob is env-overridable for prod tuning without a redeploy.
    connectionTimeoutMillis: envInt(
      "LOCALFINDS_PG_CONNECT_TIMEOUT_MS",
      POOL_DEFAULTS.connectionTimeoutMillis,
    ),
    idleTimeoutMillis: envInt(
      "LOCALFINDS_PG_IDLE_TIMEOUT_MS",
      POOL_DEFAULTS.idleTimeoutMillis,
    ),
    max: envInt("LOCALFINDS_PG_POOL_MAX", POOL_DEFAULTS.max),
    maxUses: envInt("LOCALFINDS_PG_MAX_USES", POOL_DEFAULTS.maxUses),
    keepAlive: true,
    keepAliveInitialDelayMillis: POOL_DEFAULTS.keepAliveInitialDelayMillis,
  });
  // A pg Pool re-emits backend/network errors from IDLE clients (e.g. the db
  // restarts, or — in tests — the container is torn down). With no listener,
  // node escalates these to an uncaught exception and kills the process, even
  // though the failed connection is just dropped and reopened on next use.
  p.on("error", (err) => {
    console.error("pg pool: idle client error (connection dropped):", err.message);
  });
  return p;
}

// Lazy: the connection string is read at first use (the test harness sets
// LOCALFINDS_DATABASE_URL in beforeAll, before any query runs), not at import.
let _pool: pg.Pool | undefined;
export function pool(): pg.Pool {
  return (_pool ??= createPool());
}

export async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pool().query(text, params)).rows as T[];
}

export async function queryOne<T>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await query<T>(text, params))[0];
}

export async function execute(text: string, params: unknown[] = []): Promise<number> {
  return (await pool().query(text, params)).rowCount ?? 0;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
