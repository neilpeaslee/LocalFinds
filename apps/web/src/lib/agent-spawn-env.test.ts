import { describe, it, expect } from "vitest";
import { agentSpawnEnv } from "./agent-spawn-env";

describe("agentSpawnEnv", () => {
  it("removes LOCALFINDS_DATABASE_URL so the child loads the write DSN from .env", () => {
    const out = agentSpawnEnv({
      LOCALFINDS_DATABASE_URL: "postgresql://ro@/x",
      PATH: "/bin",
    } as unknown as NodeJS.ProcessEnv);
    expect(out.LOCALFINDS_DATABASE_URL).toBeUndefined();
    expect(out.PATH).toBe("/bin");
  });

  it("does not mutate the caller's env object", () => {
    const base = {
      LOCALFINDS_DATABASE_URL: "keep-me",
    } as unknown as NodeJS.ProcessEnv;
    agentSpawnEnv(base);
    expect(base.LOCALFINDS_DATABASE_URL).toBe("keep-me");
  });
});
