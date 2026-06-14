import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTownBoundaries, readTownsConfig } from "./config";

// config.ts reads files under dataDir(), which honors LOCALFINDS_DATA_DIR — so
// point it at a throwaway dir per test and drop config files into config/.
let dir: string;
let configDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "localfinds-cfg-"));
  configDir = path.join(dir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  process.env.LOCALFINDS_DATA_DIR = dir;
});

afterEach(() => {
  delete process.env.LOCALFINDS_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(name: string, contents: string): void {
  fs.writeFileSync(path.join(configDir, name), contents);
}

describe("readTownsConfig", () => {
  it("returns an empty list when no config file exists", () => {
    expect(readTownsConfig()).toEqual({ towns: [] });
  });

  it("reads towns.json and drops malformed boxes", () => {
    writeConfig(
      "towns.json",
      JSON.stringify({
        towns: [
          { name: "Rockland", bbox: [44.07, -69.15, 44.14, -69.07], primary: true },
          { name: "Bad", bbox: [1, 2, 3] }, // wrong length — dropped
          { bbox: [1, 2, 3, 4] }, // no name — dropped
        ],
      }),
    );
    const { towns } = readTownsConfig();
    expect(towns).toHaveLength(1);
    expect(towns[0]).toMatchObject({ name: "Rockland", primary: true });
  });

  it("falls back to towns.json.example when the real file is absent", () => {
    writeConfig(
      "towns.json.example",
      JSON.stringify({ towns: [{ name: "Camden", bbox: [44.18, -69.1, 44.24, -69.02] }] }),
    );
    expect(readTownsConfig().towns).toEqual([
      { name: "Camden", bbox: [44.18, -69.1, 44.24, -69.02] },
    ]);
  });

  it("falls through to the example when towns.json is malformed JSON", () => {
    writeConfig("towns.json", "{ not valid json");
    writeConfig(
      "towns.json.example",
      JSON.stringify({ towns: [{ name: "Thomaston", bbox: [44.05, -69.22, 44.1, -69.14] }] }),
    );
    expect(readTownsConfig().towns).toEqual([
      { name: "Thomaston", bbox: [44.05, -69.22, 44.1, -69.14] },
    ]);
  });
});

describe("readTownBoundaries", () => {
  const feature = {
    type: "Feature",
    properties: { name: "Rockland", primary: true },
    geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  };

  it("returns an empty collection when no file exists", () => {
    expect(readTownBoundaries()).toEqual({ type: "FeatureCollection", features: [] });
  });

  it("reads features and drops ones missing geometry or name", () => {
    writeConfig(
      "town-boundaries.json",
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          feature,
          { type: "Feature", properties: { name: "NoGeom" } }, // no geometry — dropped
          { type: "Feature", properties: {}, geometry: feature.geometry }, // no name — dropped
        ],
      }),
    );
    const { features } = readTownBoundaries();
    expect(features).toHaveLength(1);
    expect(features[0].properties.name).toBe("Rockland");
  });

  it("falls back to the .example when the real file is absent", () => {
    writeConfig(
      "town-boundaries.json.example",
      JSON.stringify({ type: "FeatureCollection", features: [feature] }),
    );
    expect(readTownBoundaries().features).toHaveLength(1);
  });
});
