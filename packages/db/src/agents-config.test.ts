import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryParseAgentsConfig, readAgentsConfig } from "./config";

describe("tryParseAgentsConfig", () => {
  it("parses a valid positive budget", () => {
    expect(tryParseAgentsConfig('{"maxBudgetUsd":0.5}')).toEqual({ maxBudgetUsd: 0.5 });
  });
  it("returns null on malformed JSON", () => {
    expect(tryParseAgentsConfig("{not json")).toBeNull();
  });
  it("returns null on a missing or non-positive budget", () => {
    expect(tryParseAgentsConfig("{}")).toBeNull();
    expect(tryParseAgentsConfig('{"maxBudgetUsd":0}')).toBeNull();
  });
});

describe("readAgentsConfig source precedence", () => {
  const orig = process.env.LOCALFINDS_DATA_DIR;
  afterEach(() => {
    if (orig === undefined) delete process.env.LOCALFINDS_DATA_DIR;
    else process.env.LOCALFINDS_DATA_DIR = orig;
  });
  function tmpDataDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-agents-"));
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, "config", name), body);
    }
    return dir;
  }
  it("prefers a real agents.json over the .example", () => {
    process.env.LOCALFINDS_DATA_DIR = tmpDataDir({
      "agents.json": '{"maxBudgetUsd":0.25}',
      "agents.json.example": '{"maxBudgetUsd":0.5}',
    });
    expect(readAgentsConfig().maxBudgetUsd).toBe(0.25);
  });
  it("falls back to the .example when there is no real file", () => {
    process.env.LOCALFINDS_DATA_DIR = tmpDataDir({ "agents.json.example": '{"maxBudgetUsd":0.5}' });
    expect(readAgentsConfig().maxBudgetUsd).toBe(0.5);
  });
  it("falls through a malformed real file to the .example", () => {
    process.env.LOCALFINDS_DATA_DIR = tmpDataDir({
      "agents.json": "{oops",
      "agents.json.example": '{"maxBudgetUsd":0.5}',
    });
    expect(readAgentsConfig().maxBudgetUsd).toBe(0.5);
  });
  it("uses the built-in 1.0 default when nothing is present", () => {
    process.env.LOCALFINDS_DATA_DIR = tmpDataDir({});
    expect(readAgentsConfig().maxBudgetUsd).toBe(1.0);
  });
  it("falls through to the built-in default when both sources are invalid", () => {
    process.env.LOCALFINDS_DATA_DIR = tmpDataDir({
      "agents.json": "{oops",
      "agents.json.example": "{also bad",
    });
    expect(readAgentsConfig().maxBudgetUsd).toBe(1.0);
  });
});
