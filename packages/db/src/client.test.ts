import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests exercise pool *construction* only — a pg.Pool does not open a
// connection until first query, so a dummy DSN is safe and no database is
// touched. `pool()` memoizes its Pool at module scope, so each test re-imports
// the module fresh via vi.resetModules() to get an unmemoized pool built from
// that test's environment.

const ENV_KEYS = [
  "LOCALFINDS_DATABASE_URL",
  "LOCALFINDS_PG_CONNECT_TIMEOUT_MS",
  "LOCALFINDS_PG_IDLE_TIMEOUT_MS",
  "LOCALFINDS_PG_POOL_MAX",
  "LOCALFINDS_PG_MAX_USES",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.LOCALFINDS_DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/x";
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("pool() resilience config", () => {
  it("applies the hardened POOL_DEFAULTS so a Postgres blip can't wedge the process", async () => {
    const { pool, POOL_DEFAULTS } = await import("./client");
    const opts = pool().options;
    // The load-bearing one: a bounded acquire wait (pg's default is 0 = ∞).
    expect(opts.connectionTimeoutMillis).toBe(POOL_DEFAULTS.connectionTimeoutMillis);
    expect(opts.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(opts.idleTimeoutMillis).toBe(POOL_DEFAULTS.idleTimeoutMillis);
    expect(opts.max).toBe(POOL_DEFAULTS.max);
    expect(opts.maxUses).toBe(POOL_DEFAULTS.maxUses);
    expect(opts.keepAlive).toBe(true);
    expect(opts.keepAliveInitialDelayMillis).toBe(
      POOL_DEFAULTS.keepAliveInitialDelayMillis,
    );
  });

  it("lets the environment override each tuning knob for prod without a redeploy", async () => {
    process.env.LOCALFINDS_PG_CONNECT_TIMEOUT_MS = "3000";
    process.env.LOCALFINDS_PG_IDLE_TIMEOUT_MS = "15000";
    process.env.LOCALFINDS_PG_POOL_MAX = "20";
    process.env.LOCALFINDS_PG_MAX_USES = "1000";

    const { pool } = await import("./client");
    const opts = pool().options;
    expect(opts.connectionTimeoutMillis).toBe(3000);
    expect(opts.idleTimeoutMillis).toBe(15000);
    expect(opts.max).toBe(20);
    expect(opts.maxUses).toBe(1000);
  });

  it("ignores blank or non-numeric overrides, falling back to the default", async () => {
    process.env.LOCALFINDS_PG_CONNECT_TIMEOUT_MS = "   ";
    process.env.LOCALFINDS_PG_POOL_MAX = "not-a-number";

    const { pool, POOL_DEFAULTS } = await import("./client");
    const opts = pool().options;
    expect(opts.connectionTimeoutMillis).toBe(POOL_DEFAULTS.connectionTimeoutMillis);
    expect(opts.max).toBe(POOL_DEFAULTS.max);
  });
});
