import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_SETTINGS,
  loadSettings,
  resolveSettings,
  saveSettings,
  type DebloatSettings,
} from "../src/settings.js";

const tmpDirs: string[] = [];

function makeRoots(): { cwd: string; home: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "debloat-settings-"));
  const cwd = path.join(base, "project");
  const home = path.join(base, "home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  tmpDirs.push(base);
  return { cwd, home };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function globalFile(home: string): string {
  return path.join(home, ".pi", "agent", "debloat.json");
}

function projectFile(cwd: string): string {
  return path.join(cwd, ".pi", "debloat.json");
}

function writeRaw(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function writeJson(file: string, value: unknown): void {
  writeRaw(file, JSON.stringify(value));
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

const DEFAULTS = {
  checkpointThinkingLevel: "low",
  compactThinkingLevel: "low",
  maxLookbackTokens: 100_000,
};

describe("loadSettings", () => {
  it("returns defaults when both files are missing", () => {
    const { cwd, home } = makeRoots();
    const settings = loadSettings({ cwd, home });
    expect(settings).toEqual(DEFAULTS);
    expect(settings.maxLookbackTokens).toBe(100_000);
    expect(settings.checkpointThinkingLevel).toBe("low");
  });

  it("falls back to defaults for corrupt JSON without throwing", () => {
    const { cwd, home } = makeRoots();
    writeRaw(globalFile(home), "{ this is not json");
    writeRaw(projectFile(cwd), "}{");
    expect(() => loadSettings({ cwd, home })).not.toThrow();
    expect(loadSettings({ cwd, home })).toEqual(DEFAULTS);
  });

  it("falls back to {} when a layer path is a directory", () => {
    const { cwd, home } = makeRoots();
    fs.mkdirSync(globalFile(home), { recursive: true });
    fs.mkdirSync(projectFile(cwd), { recursive: true });
    expect(loadSettings({ cwd, home })).toEqual(DEFAULTS);
  });

  it.each([["[]"], ["null"], ["5"], ['"str"']])(
    "treats non-object JSON (%s) as an empty layer",
    (raw) => {
      const { cwd, home } = makeRoots();
      writeRaw(globalFile(home), raw);
      writeRaw(projectFile(cwd), raw);
      expect(loadSettings({ cwd, home })).toEqual(DEFAULTS);
    },
  );

  it("overrides per key from the project layer, other keys fall through", () => {
    const { cwd, home } = makeRoots();
    writeJson(globalFile(home), {
      checkpointModel: { provider: "anthropic", modelId: "claude" },
      checkpointThinkingLevel: "high",
      maxLookbackTokens: 500,
      globalOnly: true,
    });
    writeJson(projectFile(cwd), {
      checkpointThinkingLevel: "low",
      projectOnly: true,
    });

    const settings = loadSettings({ cwd, home });
    expect(settings.checkpointThinkingLevel).toBe("low");
    expect(settings.checkpointModel).toEqual({ provider: "anthropic", modelId: "claude" });
    expect(settings.maxLookbackTokens).toBe(500);
    expect(settings.globalOnly).toBe(true);
    expect(settings.projectOnly).toBe(true);
  });

  it("does not let a wrong-typed maxLookbackTokens break resolution", () => {
    const { cwd, home } = makeRoots();
    writeJson(globalFile(home), { maxLookbackTokens: 500 });
    writeJson(projectFile(cwd), { maxLookbackTokens: "lots" });
    expect(loadSettings({ cwd, home }).maxLookbackTokens).toBe(100_000);
  });

  it("replaces wrong-typed thinking levels with the default", () => {
    const { cwd, home } = makeRoots();
    writeJson(projectFile(cwd), { compactThinkingLevel: 5, checkpointThinkingLevel: "" });
    const settings = loadSettings({ cwd, home });
    expect(settings.compactThinkingLevel).toBe("low");
    expect(settings.checkpointThinkingLevel).toBe("low");
  });
});

describe("resolveSettings", () => {
  it("applies all defaults to an empty object", () => {
    expect(resolveSettings({})).toEqual(DEFAULTS);
  });

  it("guards non-positive / non-finite token counts", () => {
    expect(resolveSettings({ maxLookbackTokens: 0 }).maxLookbackTokens).toBe(100_000);
    expect(resolveSettings({ maxLookbackTokens: -1 }).maxLookbackTokens).toBe(100_000);
    expect(resolveSettings({ maxLookbackTokens: Number.NaN }).maxLookbackTokens).toBe(100_000);
    expect(resolveSettings({ maxLookbackTokens: Number.POSITIVE_INFINITY }).maxLookbackTokens).toBe(
      100_000,
    );
    expect(
      resolveSettings({ maxLookbackTokens: "lots" } as unknown as DebloatSettings)
        .maxLookbackTokens,
    ).toBe(100_000);
  });

  it("drops malformed model refs but keeps valid ones", () => {
    expect(resolveSettings({}).checkpointModel).toBeUndefined();
    expect(
      resolveSettings({ checkpointModel: { provider: "", modelId: "x" } }).checkpointModel,
    ).toBeUndefined();
    expect(
      resolveSettings({ compactModel: { provider: "p" } as never }).compactModel,
    ).toBeUndefined();
    expect(
      resolveSettings({ compactModel: { provider: "p", modelId: "m" } }).compactModel,
    ).toEqual({ provider: "p", modelId: "m" });
  });
});

describe("saveSettings", () => {
  it("writes only to the requested project layer", () => {
    const { cwd, home } = makeRoots();
    saveSettings({ checkpointThinkingLevel: "high" }, { cwd, home, layer: "project" });
    expect(fs.existsSync(projectFile(cwd))).toBe(true);
    expect(fs.existsSync(globalFile(home))).toBe(false);
    expect(readJson(projectFile(cwd))).toEqual({ checkpointThinkingLevel: "high" });
  });

  it("writes only to the requested global layer", () => {
    const { cwd, home } = makeRoots();
    saveSettings({ maxLookbackTokens: 42 }, { cwd, home, layer: "global" });
    expect(fs.existsSync(globalFile(home))).toBe(true);
    expect(fs.existsSync(projectFile(cwd))).toBe(false);
    expect(readJson(globalFile(home))).toEqual({ maxLookbackTokens: 42 });
  });

  it("creates parent directories and writes pretty JSON with a trailing newline", () => {
    const { cwd, home } = makeRoots();
    saveSettings({ maxLookbackTokens: 7 }, { cwd, home, layer: "global" });
    const raw = fs.readFileSync(globalFile(home), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "maxLookbackTokens": 7');
  });

  it("preserves unknown and unrelated keys from the existing layer file", () => {
    const { cwd, home } = makeRoots();
    writeJson(projectFile(cwd), {
      futureFeature: { enabled: true },
      checkpointThinkingLevel: "low",
    });
    saveSettings({ compactThinkingLevel: "high" }, { cwd, home, layer: "project" });
    expect(readJson(projectFile(cwd))).toEqual({
      futureFeature: { enabled: true },
      checkpointThinkingLevel: "low",
      compactThinkingLevel: "high",
    });
  });

  it("round-trips: load(save(x)) equals the merged expectation", () => {
    const { cwd, home } = makeRoots();
    const patch = {
      checkpointModel: { provider: "p", modelId: "m" },
      maxLookbackTokens: 1234,
    };
    const saved = saveSettings(patch, { cwd, home, layer: "project" });
    const loaded = loadSettings({ cwd, home });
    expect(loaded).toEqual({ ...DEFAULTS, ...patch });
    expect(saved).toEqual(loaded);
  });

  it("defaults to the global layer when .pi/ is absent", () => {
    const { cwd, home } = makeRoots();
    saveSettings({ checkpointThinkingLevel: "high" }, { cwd, home });
    expect(fs.existsSync(globalFile(home))).toBe(true);
    expect(fs.existsSync(projectFile(cwd))).toBe(false);
  });

  it("defaults to the project layer when .pi/ exists", () => {
    const { cwd, home } = makeRoots();
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    saveSettings({ checkpointThinkingLevel: "high" }, { cwd, home });
    expect(fs.existsSync(projectFile(cwd))).toBe(true);
    expect(fs.existsSync(globalFile(home))).toBe(false);
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("pins the documented defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      checkpointThinkingLevel: "low",
      compactThinkingLevel: "low",
      maxLookbackTokens: 100_000,
    });
  });
});
