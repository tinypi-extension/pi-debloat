/**
 * Two-layer Debloat settings (global `~/.pi/agent/debloat.json`, project
 * `<cwd>/.pi/debloat.json`). Pure Node built-ins only: no pi imports.
 *
 * Every file read is best-effort: missing / unreadable / directory / invalid
 * JSON / non-object JSON falls back to `{}` for that layer. Type guards live in
 * `resolveSettings`, which is also how defaults are applied.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface DebloatSettings {
  checkpointModel?: ModelRef;
  checkpointThinkingLevel?: string; // default "low"
  compactModel?: ModelRef;
  compactThinkingLevel?: string; // default "low"
  maxLookbackTokens?: number; // default 100_000
  [k: string]: unknown;
}

export const DEFAULT_SETTINGS: Required<
  Pick<DebloatSettings, "checkpointThinkingLevel" | "compactThinkingLevel" | "maxLookbackTokens">
> = {
  checkpointThinkingLevel: "low",
  compactThinkingLevel: "low",
  maxLookbackTokens: 100_000,
};

export interface ResolvedSettings {
  checkpointModel?: ModelRef;
  checkpointThinkingLevel: string;
  compactModel?: ModelRef;
  compactThinkingLevel: string;
  maxLookbackTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validModelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return undefined;
  if (!nonEmptyString(value.provider) || !nonEmptyString(value.modelId)) return undefined;
  return { provider: value.provider, modelId: value.modelId };
}

/** Normalize arbitrary settings into fully-resolved values (guards + defaults). */
export function resolveSettings(settings: DebloatSettings): ResolvedSettings {
  const src: Record<string, unknown> = isRecord(settings) ? settings : {};
  const checkpointModel = validModelRef(src.checkpointModel);
  const compactModel = validModelRef(src.compactModel);

  return {
    ...(checkpointModel ? { checkpointModel } : {}),
    checkpointThinkingLevel: nonEmptyString(src.checkpointThinkingLevel)
      ? src.checkpointThinkingLevel
      : DEFAULT_SETTINGS.checkpointThinkingLevel,
    ...(compactModel ? { compactModel } : {}),
    compactThinkingLevel: nonEmptyString(src.compactThinkingLevel)
      ? src.compactThinkingLevel
      : DEFAULT_SETTINGS.compactThinkingLevel,
    maxLookbackTokens: isPositiveFiniteNumber(src.maxLookbackTokens)
      ? src.maxLookbackTokens
      : DEFAULT_SETTINGS.maxLookbackTokens,
  };
}

/**
 * Keep unknown keys intact while normalizing the known ones. Used by
 * `loadSettings` so settings returned to callers always carry defaults.
 */
function withDefaults(settings: DebloatSettings): DebloatSettings {
  const resolved = resolveSettings(settings);
  const out: DebloatSettings = { ...settings };
  out.checkpointThinkingLevel = resolved.checkpointThinkingLevel;
  out.compactThinkingLevel = resolved.compactThinkingLevel;
  out.maxLookbackTokens = resolved.maxLookbackTokens;
  if (resolved.checkpointModel) out.checkpointModel = resolved.checkpointModel;
  else delete out.checkpointModel;
  if (resolved.compactModel) out.compactModel = resolved.compactModel;
  else delete out.compactModel;
  return out;
}

function globalFile(home: string): string {
  return path.join(home, ".pi", "agent", "debloat.json");
}

function projectFile(cwd: string): string {
  return path.join(cwd, ".pi", "debloat.json");
}

/** Read one layer; any failure (missing/unreadable/directory/bad JSON) → {}. */
function readLayer(file: string): DebloatSettings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? (parsed as DebloatSettings) : {};
  } catch {
    return {};
  }
}

/** Shallow-merge global then project (project wins per key), with defaults. */
export function loadSettings(opts?: { cwd?: string; home?: string }): DebloatSettings {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? os.homedir();
  const merged: DebloatSettings = {
    ...readLayer(globalFile(home)),
    ...readLayer(projectFile(cwd)),
  };
  return withDefaults(merged);
}

/** Project layer is the default target only when `<cwd>/.pi/` exists. */
function defaultLayer(cwd: string): "global" | "project" {
  try {
    return fs.statSync(path.join(cwd, ".pi")).isDirectory() ? "project" : "global";
  } catch {
    return "global";
  }
}

/**
 * Write the patch keys into the chosen layer (default: project when `.pi/`
 * exists, else global), preserving the layer file's existing keys. Returns the
 * full merged settings.
 */
export function saveSettings(
  patch: Partial<DebloatSettings>,
  opts?: { cwd?: string; home?: string; layer?: "global" | "project" },
): DebloatSettings {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? os.homedir();
  const layer = opts?.layer ?? defaultLayer(cwd);
  const file = layer === "project" ? projectFile(cwd) : globalFile(home);

  const merged: DebloatSettings = { ...readLayer(file), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  return loadSettings({ cwd, home });
}
