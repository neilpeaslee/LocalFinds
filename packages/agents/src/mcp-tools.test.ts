import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Point @localfinds/db at a throwaway data dir BEFORE importing anything that
// pulls it in, then push the schema — same pattern as the db package's tests.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "localfinds-mcp-test-"));
process.env.LOCALFINDS_DATA_DIR = tmp;

let recordSourceUpsert: (typeof import("./mcp-tools"))["recordSourceUpsert"];

beforeAll(async () => {
  execSync("npx drizzle-kit push --force", {
    cwd: path.resolve(import.meta.dirname, "../../db"),
    env: { ...process.env, LOCALFINDS_DATA_DIR: tmp },
    stdio: "ignore",
  });
  ({ recordSourceUpsert } = await import("./mcp-tools"));
}, 60_000);

describe("recordSourceUpsert run counters", () => {
  it("counts a brand-new source as added, not updated", () => {
    const counters = { added: 0, updated: 0 };
    recordSourceUpsert(
      { url: "https://new-source.example.com", name: "New Source" },
      "source-keeper",
      counters,
    );
    expect(counters).toEqual({ added: 1, updated: 0 });
  });

  it("counts a re-upsert of the same URL as updated, not added", () => {
    const args = { url: "https://existing.example.com", name: "Existing" };
    recordSourceUpsert(args, "source-keeper", { added: 0, updated: 0 }); // create
    const counters = { added: 0, updated: 0 };
    recordSourceUpsert(args, "source-keeper", counters); // re-upsert
    expect(counters).toEqual({ added: 0, updated: 1 });
  });
});
