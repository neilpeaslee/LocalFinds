import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readCategoryConfig,
  readIcpProfile,
  readMapCategories,
  readRegionConfig,
  readTownBoundaries,
  readTownsConfig,
  writeCategoryConfig,
  writeIcpProfile,
  writeRegionConfig,
  writeTownsConfig,
} from "./config";
import { agentWorkspaceDir, setConfigDirOverride } from "./paths";

// The repo's real, hand-tuned config files. The writers must round-trip these
// without dropping or mutating anything (the central data-safety guarantee), so
// the round-trip tests read straight from the live tree, not fixtures.
const realConfigDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "data",
  "config",
);

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

describe("readMapCategories / themeOf", () => {
  const cfgJson = JSON.stringify({
    themes: [
      { key: "outdoors", label: "Outdoors & Rec", color: "#10b981",
        subtypes: { "leisure=park": "Park", "leisure=dog_park": "Dog Park" } },
      { key: "retail", label: "Shops & Retail", color: "#8b5cf6", subtypes: { "shop=*": "Shop" } },
      { key: "cannabis", label: "Cannabis", color: "#65a30d", subtypes: { "shop=cannabis": "Dispensary" } },
    ],
    otherKey: "other", otherLabel: "Other", otherColor: "#64748b",
  });

  it("resolves an exact kind to its theme + sub-type", () => {
    writeConfig("map-categories.json", cfgJson);
    const r = readMapCategories().themeOf("leisure=dog_park");
    expect(r).toEqual({ key: "outdoors", label: "Outdoors & Rec", color: "#10b981",
      subtype: "Dog Park", subtypeKey: "leisure=dog_park" });
  });

  it("resolves a wildcard kind, keeping the wildcard as the sub-type key", () => {
    writeConfig("map-categories.json", cfgJson);
    const r = readMapCategories().themeOf("shop=bakery");
    expect(r).toMatchObject({ key: "retail", subtype: "Shop", subtypeKey: "shop=*" });
  });

  it("prefers an exact match over a wildcard (shop=cannabis -> cannabis, not retail)", () => {
    writeConfig("map-categories.json", cfgJson);
    expect(readMapCategories().themeOf("shop=cannabis").key).toBe("cannabis");
  });

  it("falls back to the Other theme for an unmapped or null kind", () => {
    writeConfig("map-categories.json", cfgJson);
    const cfg = readMapCategories();
    expect(cfg.themeOf("highway=residential")).toEqual({ key: "other", label: "Other",
      color: "#64748b", subtype: null, subtypeKey: null });
    expect(cfg.themeOf(null).key).toBe("other");
  });

  it("falls back to the .example when the real file is absent", () => {
    writeConfig("map-categories.json.example", cfgJson);
    expect(readMapCategories().themeOf("leisure=park").key).toBe("outdoors");
  });

  it("falls through to the .example when map-categories.json is malformed JSON", () => {
    writeConfig("map-categories.json", "{ bad json");
    writeConfig("map-categories.json.example", cfgJson);
    expect(readMapCategories().themeOf("leisure=park").key).toBe("outdoors");
  });

  it("uses a safe default (everything -> Other) when no file is present", () => {
    const cfg = readMapCategories();
    expect(cfg.themes).toEqual([]);
    expect(cfg.themeOf("amenity=cafe").key).toBe("other");
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

// --- Config writers (the interviewer's durable foundation) ---

describe("writeRegionConfig", () => {
  it("round-trips the live region.md: name parses back and prose is preserved", () => {
    const realRaw = fs.readFileSync(path.join(realConfigDir, "region.md"), "utf8");
    writeConfig("region.md", realRaw);
    const before = readRegionConfig()!;
    const body = (raw: string) => raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

    writeRegionConfig({ name: before.name, coverageMarkdown: body(before.raw) });

    const after = readRegionConfig()!;
    expect(after.name).toBe(before.name);
    expect(body(after.raw)).toBe(body(before.raw));
  });

  it("quotes the name so readRegionConfig parses it back unchanged", () => {
    writeRegionConfig({ name: "Rockland, Maine", coverageMarkdown: "## Coverage\n\nKnox County." });
    const cfg = readRegionConfig()!;
    expect(cfg.name).toBe("Rockland, Maine");
    expect(cfg.raw).toContain("## Coverage");
  });
});

describe("writeTownsConfig", () => {
  it("round-trips the live towns.json without dropping a town, bbox, county, or query", () => {
    const realParsed = JSON.parse(
      fs.readFileSync(path.join(realConfigDir, "towns.json"), "utf8"),
    );
    writeTownsConfig(realParsed.towns, { comment: realParsed._comment });

    const written = JSON.parse(
      fs.readFileSync(path.join(configDir, "towns.json"), "utf8"),
    );
    expect(written.towns).toEqual(realParsed.towns);
    expect(written._comment).toBe(realParsed._comment);
    // And the public reader still accepts every written town.
    expect(readTownsConfig().towns).toHaveLength(realParsed.towns.length);
  });

  it("preserves county and query fields through the writer", () => {
    writeTownsConfig([
      { name: "Matinicus Isle", county: "Knox County", query: "Matinicus Isle Plantation", bbox: [43.7, -69.0, 43.9, -68.7] },
    ]);
    const written = JSON.parse(fs.readFileSync(path.join(configDir, "towns.json"), "utf8"));
    expect(written.towns[0]).toMatchObject({
      county: "Knox County",
      query: "Matinicus Isle Plantation",
    });
  });

  it("throws on a bad bbox rather than silently dropping the town", () => {
    expect(() =>
      writeTownsConfig([{ name: "Bad", bbox: [1, 2, 3] as never }]),
    ).toThrow();
    // Nothing must have been written.
    expect(fs.existsSync(path.join(configDir, "towns.json"))).toBe(false);
  });
});

describe("writeCategoryConfig", () => {
  it("round-trips the live categories.json: every real key=value entry survives", () => {
    const realParsed = JSON.parse(
      fs.readFileSync(path.join(realConfigDir, "categories.json"), "utf8"),
    );
    writeCategoryConfig(
      {
        default_tier: realParsed.default_tier,
        hide_in_directory: realParsed.hide_in_directory,
        tiers: realParsed.tiers,
      },
      { comment: realParsed._comment },
    );
    const written = JSON.parse(
      fs.readFileSync(path.join(configDir, "categories.json"), "utf8"),
    );
    expect(written.default_tier).toBe(realParsed.default_tier);
    expect(written.hide_in_directory).toEqual(realParsed.hide_in_directory);
    expect(written.tiers).toEqual(realParsed.tiers);
    // The reader maps the live config back to the same tier rankings.
    const cfg = readCategoryConfig();
    expect(cfg.tierOf("amenity=library")).toBe(1);
    expect(cfg.tierOf("craft=anything")).toBe(2); // craft=* wildcard
    expect(cfg.tierOf("amenity=parking")).toBe(4);
  });

  it("rejects a category that isn't OSM key=value shaped", () => {
    expect(() =>
      writeCategoryConfig({
        default_tier: 3,
        hide_in_directory: { tier4: true, chains: true },
        tiers: { "1": ["notavalidcategory"] },
      }),
    ).toThrow();
  });

  it("accepts a key=* wildcard", () => {
    expect(() =>
      writeCategoryConfig({
        default_tier: 3,
        hide_in_directory: { tier4: true, chains: true },
        tiers: { "2": ["craft=*"] },
      }),
    ).not.toThrow();
  });
});

describe("readIcpProfile / writeIcpProfile", () => {
  let prospectorDir: string;
  beforeEach(() => {
    prospectorDir = agentWorkspaceDir("prospector");
    fs.mkdirSync(prospectorDir, { recursive: true });
    fs.writeFileSync(
      path.join(prospectorDir, "profile.md.example"),
      "# Prospector ICP\n\n(e.g. fill me in)\n",
    );
  });

  it("returns null when no profile.md exists", () => {
    expect(readIcpProfile()).toBeNull();
  });

  it("returns null when profile.md is byte-identical to the .example (untouched)", () => {
    fs.copyFileSync(
      path.join(prospectorDir, "profile.md.example"),
      path.join(prospectorDir, "profile.md"),
    );
    expect(readIcpProfile()).toBeNull();
  });

  it("writes the ICP and reads it back once it differs from the template", () => {
    writeIcpProfile("# Prospector ICP\n\nWe sell websites to Rockland cafes.\n");
    expect(readIcpProfile()).toContain("Rockland cafes");
  });

  it("creates the workspace + notes/ directory on write", () => {
    fs.rmSync(prospectorDir, { recursive: true, force: true });
    writeIcpProfile("# ICP\n\nreal content\n");
    expect(fs.existsSync(path.join(agentWorkspaceDir("prospector"), "notes"))).toBe(true);
  });
});

describe("config-dir staging override", () => {
  afterEach(() => setConfigDirOverride(undefined));

  it("routes config + ICP writes to the override dir", () => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "lf-staging-"));
    setConfigDirOverride(staging);

    writeRegionConfig({ name: "Testville, Maine", coverageMarkdown: "Coverage." });
    writeIcpProfile("# Staged ICP\n");

    expect(fs.existsSync(path.join(staging, "config", "region.md"))).toBe(true);
    expect(fs.existsSync(path.join(staging, "agents", "prospector", "profile.md"))).toBe(true);
    expect(readRegionConfig()?.name).toBe("Testville, Maine");
    expect(readIcpProfile()).toBe("# Staged ICP\n");

    setConfigDirOverride(undefined);
    // Back to the real dir → the staged region is no longer what we read.
    expect(readRegionConfig()?.name).not.toBe("Testville, Maine");
  });
});
