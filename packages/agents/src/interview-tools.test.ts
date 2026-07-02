import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertFind, writeRegionConfig, writeTownsConfig, type WritableTown } from "@localfinds/db";
import { resetDb, setupPgDatabase, teardownPgDatabase } from "@localfinds/db/test-harness";
import type { GeocodeInput, GeocodeResult } from "./geocode";
import {
  currentConfig,
  deriveState,
  resolveTowns,
  reviewRunResults,
  runSetTowns,
  type InterviewIO,
  type SetTownsInput,
} from "./interview-tools";

function fakeIO(answers: string[] = []) {
  const said: string[] = [];
  const asked: string[] = [];
  let i = 0;
  const io: InterviewIO = {
    say: (m) => {
      said.push(m);
    },
    ask: async (q) => {
      asked.push(q);
      return answers[i++] ?? "";
    },
  };
  return { io, said, asked };
}

const ROCKLAND: WritableTown = {
  name: "Rockland",
  county: "Knox County",
  bbox: [44.0819, -69.1853, 44.1726, -69.0695],
  primary: true,
};

describe("deriveState", () => {
  it("takes the last comma-separated segment of the region name", () => {
    expect(deriveState("Rockland, Maine")).toBe("Maine");
    expect(deriveState("Portland, Multnomah County, Oregon")).toBe("Oregon");
  });
});

describe("resolveTowns", () => {
  it("preserves an existing town's hand-tuned bbox and geocodes only the new town", async () => {
    let geocodeArgs: GeocodeInput[] | null = null;
    const geocode = async (inputs: GeocodeInput[]): Promise<GeocodeResult[]> => {
      geocodeArgs = inputs;
      return inputs.map((i) => ({
        name: i.name,
        bbox: [10, 20, 30, 40] as [number, number, number, number],
        lat: 1,
        lng: 2,
      }));
    };

    const inputs: SetTownsInput[] = [
      { name: "Rockland", county: "Knox County", primary: true },
      { name: "Camden", county: "Knox County" },
    ];
    const res = await resolveTowns(inputs, [ROCKLAND], "Maine", geocode);

    // Rockland kept its tuned bbox; Camden got the geocoded one.
    expect(res.towns.find((t) => t.name === "Rockland")!.bbox).toEqual(ROCKLAND.bbox);
    expect(res.towns.find((t) => t.name === "Camden")!.bbox).toEqual([10, 20, 30, 40]);
    // Only the genuinely new town was geocoded.
    expect(geocodeArgs).toEqual([{ name: "Camden", county: "Knox County", state: "Maine" }]);
    expect(res.coordsChanged).toBe(true);
  });

  it("does not geocode when every town already exists (no coordinate change)", async () => {
    let called = false;
    const geocode = async (): Promise<GeocodeResult[]> => {
      called = true;
      return [];
    };
    const res = await resolveTowns(
      [{ name: "Rockland", county: "Knox County", primary: true }],
      [ROCKLAND],
      "Maine",
      geocode,
    );
    expect(called).toBe(false);
    expect(res.coordsChanged).toBe(false);
    expect(res.towns[0].bbox).toEqual(ROCKLAND.bbox);
  });

  it("reports a town that fails to geocode and excludes it from the written set", async () => {
    const geocode = async (inputs: GeocodeInput[]): Promise<GeocodeResult[]> =>
      inputs.map((i) => ({ name: i.name, error: "no match" }));
    const res = await resolveTowns(
      [{ name: "Ghosttown", county: "Knox County" }],
      [],
      "Maine",
      geocode,
    );
    expect(res.towns).toHaveLength(0);
    expect(res.perTown[0]).toMatchObject({ name: "Ghosttown", error: "no match" });
  });

  it("flags a coordinate change when a town is removed", async () => {
    const geocode = async (): Promise<GeocodeResult[]> => [];
    const res = await resolveTowns([], [ROCKLAND], "Maine", geocode);
    expect(res.coordsChanged).toBe(true);
    expect(res.towns).toHaveLength(0);
  });
});

describe("with a data dir", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "localfinds-itools-"));
    process.env.LOCALFINDS_DATA_DIR = dir;
  });
  afterEach(() => {
    delete process.env.LOCALFINDS_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("currentConfig", () => {
    it("returns nulls/empties before anything is written", () => {
      const c = currentConfig();
      expect(c.region).toBeNull();
      expect(c.icp).toBeNull();
      expect(c.towns).toEqual([]);
    });

    it("reflects the region and ICP once written", () => {
      writeRegionConfig({ name: "Rockland, Maine", coverageMarkdown: "## Coverage\n\nKnox County." });
      const c = currentConfig();
      expect(c.region?.name).toBe("Rockland, Maine");
    });
  });

  describe("runSetTowns", () => {
    beforeEach(() => {
      writeRegionConfig({
        name: "Rockland, Maine",
        coverageMarkdown: "## Coverage\n\nKnox County.",
      });
      writeTownsConfig([ROCKLAND], { comment: "hand-tuned — keep" });
    });

    it("keeps the existing bbox, adds the new town, and reminds about boundaries:fetch", async () => {
      const { io, said } = fakeIO();
      const geocode = async (inputs: GeocodeInput[]): Promise<GeocodeResult[]> =>
        inputs.map((i) => ({
          name: i.name,
          bbox: [10, 20, 30, 40] as [number, number, number, number],
          lat: 1,
          lng: 2,
        }));

      const perTown = await runSetTowns(
        [
          { name: "Rockland", county: "Knox County", primary: true },
          { name: "Camden", county: "Knox County" },
        ],
        io,
        geocode,
      );

      const written = JSON.parse(
        fs.readFileSync(path.join(dir, "config", "towns.json"), "utf8"),
      );
      const rockland = written.towns.find((t: WritableTown) => t.name === "Rockland");
      const camden = written.towns.find((t: WritableTown) => t.name === "Camden");
      expect(rockland.bbox).toEqual(ROCKLAND.bbox);
      expect(camden.bbox).toEqual([10, 20, 30, 40]);
      // The helpful comment survived the rewrite.
      expect(written._comment).toBe("hand-tuned — keep");
      // The boundaries:fetch reminder fired because coordinates changed.
      expect(said.join(" ")).toMatch(/boundaries:fetch/);
      expect(perTown).toHaveLength(2);
    });

    it("errors when the region isn't set yet", async () => {
      fs.rmSync(path.join(dir, "config", "region.md"));
      const { io } = fakeIO();
      const geocode = async (): Promise<GeocodeResult[]> => [];
      await expect(runSetTowns([{ name: "Camden" }], io, geocode)).rejects.toThrow();
    });
  });
});

describe("reviewRunResults", () => {
  beforeAll(setupPgDatabase, 120_000);
  afterAll(teardownPgDatabase);
  afterEach(resetDb);

  it("returns provisional leads and the scratch coverage note", async () => {
    await insertFind({
      title: "Provisional Co",
      type: "lead",
      agent: "prospector",
      score: 0.7,
      tags: ["maker"],
      status: "provisional",
    });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lf-scratch-"));
    fs.mkdirSync(path.join(scratch, "notes"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "notes", "coverage.md"), "Walked Rockland. Skipped X.");

    const out = await reviewRunResults({ runId: 42, scratchDir: scratch });
    expect(out.runId).toBe(42);
    expect(out.leads.map((l) => l.title)).toContain("Provisional Co");
    expect(out.coverageNote).toContain("Skipped X");
  });
});
