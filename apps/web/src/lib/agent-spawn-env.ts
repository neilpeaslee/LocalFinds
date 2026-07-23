// The Next app process runs with the read-only .env.production DB role. A spawned
// agent CLI must NOT inherit that DSN: it needs the WRITE role, which its own
// loadEnv() pulls from the box .env — but loadEnv leaves an already-set var alone
// (real env wins). So strip LOCALFINDS_DATABASE_URL from the child's env and let
// loadEnv populate the write DSN (and ANTHROPIC_API_KEY) from /var/www/localfinds/.env.
export function agentSpawnEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.LOCALFINDS_DATABASE_URL;
  return env;
}
