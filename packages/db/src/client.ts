import pg from "pg";

// Global type parsers — registered once at module load, before any pool exists.
// int8 (OID 20) -> Number: all identity ids are far below MAX_SAFE_INTEGER (C1).
pg.types.setTypeParser(20, (v: string | null) => (v === null ? null : Number(v)));
// timestamptz (1184) / timestamp (1114) -> ISO-8601 string, the app's date contract (C2).
const toIso = (v: string | null) => (v === null ? null : new Date(v).toISOString());
pg.types.setTypeParser(1184, toIso);
pg.types.setTypeParser(1114, toIso);

function createPool(): pg.Pool {
  const connectionString = process.env.LOCALFINDS_DATABASE_URL;
  if (!connectionString) throw new Error("LOCALFINDS_DATABASE_URL is not set");
  const p = new pg.Pool({ connectionString });
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
