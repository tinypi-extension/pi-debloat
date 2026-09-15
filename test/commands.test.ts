/**
 * Command/glue coverage for the three Debloat command handlers and for
 * `createCaller`'s provider/fallback wiring.
 *
 * Everything is driven through the public handler surface with hand-rolled
 * `pi`/`ctx` stubs: no network, no live model calls, no writes to the real
 * `~/.pi` or the repo's `.pi/`. Settings live in a `mkdtempSync` root with
 * `cwd`/`HOME` redirected (and restored) per test.
 *
 * Findings covered (see tasks/contract.md "Post-review amendments"):
 *   - Fix B  thinking level reaches `streamSimple` as `options.reasoning`
 *   - Fix G  /checkpoint-make notify reports the scanned span + token total
 *   - Fix F  /compact-checkpoint notify carries usage tokens/cost
 *   - Fix E  /compact-checkpoint uses the wide per-entry transcript budget
 *   - Fix D  a rejected (overlapping) compaction is warned about, not counted
 *   - Fix I  timeline marks a checkpoint compacted at either span endpoint
 *   - Fix J  /debloat settings resolves the default layer and names the file
 *   - no-op  /compact-checkpoint without checkpoints makes no call/no append
 *   - defect: `createCaller` must not fall back to `complete()` after a stream
 *     has already been dispatched (double-billing)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCheckpointMake } from "../src/commands/checkpoint-make.js";
import { runCompactCheckpoint } from "../src/commands/compact-checkpoint.js";
import { runDebloat } from "../src/commands/debloat.js";
import { createCaller } from "../src/pi-glue.js";
import * as ranges from "../src/ranges.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  COMPACTION_CUSTOM_TYPE,
  type EntryLike,
  type MessageLike,
} from "../src/state.js";

/* ------------------------------------------------------------------ fixtures */

const MODEL_REF = { provider: "fake", modelId: "model-1" };

function msg(id: string, role: string, content: unknown): EntryLike {
  return { id, type: "message", message: { role, content } as MessageLike };
}

function checkpoint(id: string, afterEntryId: string, label: string): EntryLike {
  return {
    id,
    type: "custom",
    customType: CHECKPOINT_CUSTOM_TYPE,
    data: { afterEntryId, label },
  };
}

function compaction(
  id: string,
  fromAfterEntryId: string,
  toAfterEntryId: string,
  title: string,
  summary: string,
): EntryLike {
  return {
    id,
    type: "custom",
    customType: COMPACTION_CUSTOM_TYPE,
    data: { fromAfterEntryId, toAfterEntryId, title, summary },
  };
}

/** Three plain turns: e1..e6, leaf e6. */
function conversation(): EntryLike[] {
  return [
    msg("e1", "user", "u1"),
    msg("e2", "assistant", "a1"),
    msg("e3", "user", "u2"),
    msg("e4", "assistant", "a2"),
    msg("e5", "user", "u3"),
    msg("e6", "assistant", "a3"),
  ];
}

/** Two active checkpoints => exactly one compactable span (e2, e4]. */
function compactableBranch(): EntryLike[] {
  return [
    msg("e1", "user", "u1"),
    msg("e2", "assistant", "a1"),
    checkpoint("c1", "e2", "one"),
    msg("e3", "user", "u2"),
    msg("e4", "assistant", "a2"),
    checkpoint("c2", "e4", "two"),
    msg("e5", "user", "u3"),
    msg("e6", "assistant", "a3"),
  ];
}

const USAGE = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
};

/* ------------------------------------------------------------ temp env / fs */

const ORIGINAL_CWD = process.cwd();
let originalHome: string | undefined;
const tmpDirs: string[] = [];

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface TempEnv {
  root: string;
  cwd: string;
  home: string;
}

/**
 * Redirect `process.cwd()` and `$HOME` (so `os.homedir()`) into a throwaway
 * root. Only used by tests that go through `loadSettings()`/`saveSettings()`,
 * which read the process-level defaults.
 */
function tempEnv(): TempEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "debloat-cmd-"));
  tmpDirs.push(root);
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.chdir(cwd);
  return { root, cwd, home };
}

function settingsFile(env: TempEnv, layer: "global" | "project"): string {
  return layer === "global"
    ? path.join(env.home, ".pi", "agent", "debloat.json")
    : path.join(env.cwd, ".pi", "debloat.json");
}

function writeSettings(env: TempEnv, layer: "global" | "project", patch: unknown): string {
  const file = settingsFile(env, layer);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(patch), "utf8");
  return file;
}

/* -------------------------------------------------------------- pi/ctx stubs */

interface AppendedEntry {
  customType: string;
  data: unknown;
}

/**
 * `appendEntry` is faithful to pi: it records the entry *and* appends it to the
 * branch, so a re-`deriveState(getBranch())` after the write sees it (this is
 * what Fix D's safety net checks).
 */
function makePi(branch: EntryLike[]): { pi: ExtensionAPI; appended: AppendedEntry[] } {
  const appended: AppendedEntry[] = [];
  let counter = 0;
  const pi = {
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
      counter += 1;
      branch.push({ id: `appended-${counter}`, type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, appended };
}

interface CapturedStream {
  model: unknown;
  context: {
    systemPrompt?: string;
    messages: { role: string; content: { type: string; text: string }[] }[];
  };
  options: Record<string, unknown>;
}

interface RegistryOptions {
  /** Canned text per `streamSimple` call (last value repeats). */
  texts?: string[];
  usage?: unknown;
  /** Provider has no `streamSimple` at all. */
  noStreamSimple?: boolean;
  /** `streamSimple` throws synchronously, i.e. before the request is dispatched. */
  streamSimpleThrows?: boolean;
  /** `stream.result()` rejects, i.e. after the request was dispatched. */
  resultRejects?: boolean;
  completeText?: string;
  completeThrows?: boolean;
}

/**
 * Minimal `ctx.modelRegistry` faithful to what `src/pi-glue.ts` (and the
 * `/debloat settings` dialog) actually reads, capturing the exact options object
 * handed to the provider.
 */
function makeRegistry(options: RegistryOptions = {}): {
  registry: unknown;
  captured: CapturedStream[];
  completeCalls: { model: unknown; context: unknown; options: unknown }[];
  model: { provider: string; id: string; modelId: string };
} {
  const captured: CapturedStream[] = [];
  const completeCalls: { model: unknown; context: unknown; options: unknown }[] = [];
  const model = { provider: "fake", id: "model-1", modelId: "model-1" };
  const texts = options.texts ?? ["[]"];
  let index = 0;

  const provider = {
    streamSimple(
      streamModel: unknown,
      context: CapturedStream["context"],
      streamOptions: Record<string, unknown>,
    ) {
      if (options.streamSimpleThrows) throw new Error("streamSimple setup exploded");
      captured.push({ model: streamModel, context, options: streamOptions });
      const text = texts[Math.min(index, texts.length - 1)] ?? "[]";
      index += 1;
      return {
        result: async () => {
          if (options.resultRejects) throw new Error("stream result rejected");
          return { content: [{ type: "text", text }], usage: options.usage };
        },
      };
    },
  };

  const registry = {
    find: (providerId: string, modelId: string) =>
      providerId === model.provider && modelId === model.modelId ? model : undefined,
    getProvider: () => (options.noStreamSimple ? {} : provider),
    getProviderDisplayName: () => "Fake",
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k" }),
    getApiKeyForProvider: async () => "k",
    getAvailable: () => [model],
    complete: async (completeModel: unknown, context: unknown, completeOptions: unknown) => {
      completeCalls.push({ model: completeModel, context, options: completeOptions });
      if (options.completeThrows) throw new Error("complete exploded");
      return {
        content: [{ type: "text", text: options.completeText ?? "[]" }],
        usage: options.usage,
      };
    },
  };

  return { registry, captured, completeCalls, model };
}

interface UiLog {
  notifies: { msg: string; level?: string }[];
  statuses: { key: string; text: string | undefined }[];
  selectTitles: string[];
  inputTitles: string[];
}

interface CtxOptions {
  branch: EntryLike[];
  registry: unknown;
  leafId?: string | null;
  confirm?: boolean;
  selectAnswers?: (string | undefined)[];
  inputAnswers?: (string | undefined)[];
}

function makeCtx(options: CtxOptions): { ctx: ExtensionCommandContext; ui: UiLog } {
  const ui: UiLog = { notifies: [], statuses: [], selectTitles: [], inputTitles: [] };
  const selects = [...(options.selectAnswers ?? [])];
  const inputs = [...(options.inputAnswers ?? [])];
  const ctx = {
    hasUI: true,
    ui: {
      notify(message: string, level?: string) {
        ui.notifies.push(level === undefined ? { msg: message } : { msg: message, level });
      },
      setStatus(key: string, text: string | undefined) {
        ui.statuses.push({ key, text });
      },
      async select(title: string) {
        ui.selectTitles.push(title);
        return selects.shift();
      },
      async input(title: string) {
        ui.inputTitles.push(title);
        return inputs.shift();
      },
      async confirm() {
        return options.confirm ?? false;
      },
    },
    modelRegistry: options.registry,
    sessionManager: {
      getBranch: () => options.branch,
      getLeafId: () => options.leafId ?? null,
      getSessionId: () => "session-1",
    },
  };
  return { ctx: ctx as unknown as ExtensionCommandContext, ui };
}

function userPromptOf(captured: CapturedStream): string {
  return captured.context.messages[0]?.content[0]?.text ?? "";
}

function notifyText(ui: UiLog): string {
  return ui.notifies.map((entry) => entry.msg).join("\n");
}

/* ------------------------------------------------------------ Fix B: reasoning */

describe("Fix B: the configured thinking level reaches the provider", () => {
  it.each([
    ["high", "high"],
    ["off", undefined],
    ["banana", undefined],
  ])(
    "/checkpoint-make passes checkpointThinkingLevel=%s as options.reasoning",
    async (level, expected) => {
      const env = tempEnv();
      writeSettings(env, "global", {
        checkpointModel: MODEL_REF,
        checkpointThinkingLevel: level,
      });
      const branch = conversation();
      const { registry, captured } = makeRegistry({
        texts: ['[{"afterEntryId":"e2","label":"turn-one"}]'],
      });
      const { pi } = makePi(branch);
      const { ctx } = makeCtx({ branch, registry, leafId: "e6" });

      await runCheckpointMake(pi, "", ctx);

      expect(captured).toHaveLength(1);
      if (expected === undefined) {
        expect("reasoning" in captured[0]!.options).toBe(false);
      } else {
        expect(captured[0]!.options.reasoning).toBe(expected);
      }
      expect("reasoning" in captured[0]!.options).toBe(expected !== undefined);
    },
  );

  it.each([
    ["high", "high"],
    ["off", undefined],
    ["banana", undefined],
  ])(
    "/compact-checkpoint passes compactThinkingLevel=%s as options.reasoning",
    async (level, expected) => {
      const env = tempEnv();
      writeSettings(env, "global", {
        compactModel: MODEL_REF,
        compactThinkingLevel: level,
      });
      const branch = compactableBranch();
      const { registry, captured } = makeRegistry({
        texts: ['{"title":"span-one","summary":"compacted"}'],
      });
      const { pi } = makePi(branch);
      const { ctx } = makeCtx({ branch, registry, leafId: "e6" });

      await runCompactCheckpoint(pi, "", ctx);

      expect(captured).toHaveLength(1);
      if (expected === undefined) {
        expect("reasoning" in captured[0]!.options).toBe(false);
      } else {
        expect(captured[0]!.options.reasoning).toBe(expected);
      }
      expect("reasoning" in captured[0]!.options).toBe(expected !== undefined);
    },
  );
});

/* --------------------------------------------- Fix G (criterion 2): scanned span */

describe("Fix G (criterion 2): /checkpoint-make reports the scanned span", () => {
  it("notifies span + token total and appends one debloat-checkpoint per accepted boundary", async () => {
    const env = tempEnv();
    writeSettings(env, "global", { checkpointModel: MODEL_REF });
    const branch = conversation();
    const { registry, captured } = makeRegistry({
      texts: [
        '[{"afterEntryId":"e2","label":"turn-one"},{"afterEntryId":"e4","label":"turn-two"}]',
      ],
    });
    const { pi, appended } = makePi(branch);
    const { ctx, ui } = makeCtx({ branch, registry, leafId: "e6" });

    await runCheckpointMake(pi, "", ctx);

    expect(captured).toHaveLength(1);
    const text = notifyText(ui);
    expect(text).toContain("scanned 6 message(s) (~6 tokens) since session start");
    expect(text).toContain("placed 2 checkpoint(s): turn-one, turn-two");

    expect(appended).toEqual([
      { customType: CHECKPOINT_CUSTOM_TYPE, data: { afterEntryId: "e2", label: "turn-one" } },
      { customType: CHECKPOINT_CUSTOM_TYPE, data: { afterEntryId: "e4", label: "turn-two" } },
    ]);
  });
});

/* -------------------------------------------------- Fix F: usage in the summary */

describe("Fix F: /compact-checkpoint reports usage totals", () => {
  it("sums the canned token/cost usage into the final notify", async () => {
    const env = tempEnv();
    writeSettings(env, "global", { compactModel: MODEL_REF });
    const branch = compactableBranch();
    const { registry, captured } = makeRegistry({
      texts: ['{"title":"span-one","summary":"compacted"}'],
      usage: USAGE,
    });
    const { pi, appended } = makePi(branch);
    const { ctx, ui } = makeCtx({ branch, registry, leafId: "e6" });

    await runCompactCheckpoint(pi, "", ctx);

    expect(captured).toHaveLength(1);
    const final = ui.notifies.at(-1)!.msg;
    expect(final).toContain("compacted 1 span(s)");
    expect(final).toContain("tokens 10 in / 20 out / 30 total");
    expect(final).toContain("$0.001");
    // The usage also rides on the appended compaction entry.
    expect(appended[0]!.customType).toBe(COMPACTION_CUSTOM_TYPE);
    expect(appended[0]!.data).toMatchObject({ usage: USAGE });
  });
});

/* -------------------------------------------- Fix E: wide transcript budget call */

describe("Fix E: /compact-checkpoint uses COMPACT_MAX_CHARS_PER_ENTRY", () => {
  it("sends a >2000-char span body untruncated to the compactor", async () => {
    const env = tempEnv();
    writeSettings(env, "global", { compactModel: MODEL_REF });
    const big = "B".repeat(5000);
    const branch = compactableBranch();
    // e4 (inside the compactable span (e2, e4]) carries the long body.
    branch[4] = msg("e4", "assistant", big);

    // The default 2000-char budget would truncate this; the compactor budget must not.
    const { registry, captured } = makeRegistry({
      texts: ['{"title":"span-one","summary":"compacted"}'],
    });
    const { pi } = makePi(branch);
    const { ctx } = makeCtx({ branch, registry, leafId: "e6" });

    await runCompactCheckpoint(pi, "", ctx);

    expect(captured).toHaveLength(1);
    const prompt = userPromptOf(captured[0]!);
    expect(prompt).toContain(big);
    expect(prompt).not.toContain("[truncated");
  });
});

/* ------------------------------------------------- Fix D: overlapping-span safety net */

describe("Fix D: a compaction that deriveState rejects is warned about, not counted", () => {
  it("warns and reports 0 compacted when the appended span overlaps an existing summary", async () => {
    const env = tempEnv();
    writeSettings(env, "global", { compactModel: MODEL_REF });
    const branch = compactableBranch();
    // The pre-existing summary spans (e1, e3], which overlaps the candidate
    // span (e2, e4] at real entry positions. Its endpoints are not checkpoint
    // anchors, so `computeSpans` still proposes (e2, e4] as compactable — but
    // `deriveState` rejects the newly appended entry as overlapping.
    branch.push(compaction("k1", "e1", "e3", "pre-existing", "overlaps the candidate span"));

    const { registry, captured } = makeRegistry({
      texts: ['{"title":"span-one","summary":"compacted"}'],
    });
    const { pi, appended } = makePi(branch);
    const { ctx, ui } = makeCtx({ branch, registry, leafId: "e6" });

    await runCompactCheckpoint(pi, "", ctx);

    // The span was attempted and recorded...
    expect(captured).toHaveLength(1);
    expect(appended).toHaveLength(1);
    // ...but the safety net caught the rejection.
    const text = notifyText(ui);
    expect(text).toContain("was not applied (it overlaps an existing summary)");
    expect(text).toContain("compacted 0 span(s); 1 rejected as overlapping");
    expect(text).not.toContain("compacted 1 span(s)");
  });

  it("counts an accepted compaction (control for the safety net)", async () => {
    const env = tempEnv();
    writeSettings(env, "global", { compactModel: MODEL_REF });
    const branch = compactableBranch();
    const { registry } = makeRegistry({
      texts: ['{"title":"span-one","summary":"compacted"}'],
    });
    const { pi, appended } = makePi(branch);
    const { ctx, ui } = makeCtx({ branch, registry, leafId: "e6" });

    await runCompactCheckpoint(pi, "", ctx);

    expect(appended).toHaveLength(1);
    expect(ui.notifies.at(-1)!.msg).toContain("compacted 1 span(s)");
  });
});

/* ------------------------------------------------------ Fix I: timeline marks */

describe("Fix I: /debloat timeline marks a checkpoint compacted at either endpoint", () => {
  it("marks the checkpoint that is the span's toAfterEntryId (not only the from)", async () => {
    const branch = compactableBranch();
    branch.push(compaction("k1", "e2", "e4", "one-to-two", "compacted"));
    const { registry } = makeRegistry();
    const { pi } = makePi(branch);
    const { ctx, ui } = makeCtx({ branch, registry, leafId: "e6" });

    await runDebloat(pi, "timeline", ctx);

    const text = ui.notifies[0]!.msg;
    expect(text).toContain("[x] one");
    expect(text).toContain("[x] two");
    expect(text).toContain("one-to-two  e2→e4");
    expect(text).toContain("raw: two → current");
  });

  it("leaves an uncompacted checkpoint unmarked", async () => {
    const branch = compactableBranch();
    const { registry } = makeRegistry();
    const { pi } = makePi(branch);
    const { ctx, ui } = makeCtx({ branch, registry, leafId: "e6" });

    await runDebloat(pi, "timeline", ctx);

    const text = ui.notifies[0]!.msg;
    expect(text).toContain("[ ] one");
    expect(text).toContain("[ ] two");
  });
});

/* ------------------- defect 1 guard: unreachable null label in the raw-span line */

describe("defect 1: the timeline raw-span label never renders a bare null", () => {
  it("renders the session-start fallback when newestRaw.fromLabel is null", async () => {
    // `computeSpans` always sets a string label (`Span.fromLabel` is only typed
    // `string | null`), so the null branch is unreachable through the real
    // public call path. The spy pins the rendering contract that the
    // dead-branch cleanup must preserve; it is green before and after the fix.
    const spy = vi.spyOn(ranges, "computeSpans").mockReturnValue({
      compactable: [],
      newestRaw: {
        fromAfterEntryId: "e2",
        toAfterEntryId: "e6",
        fromLabel: null,
        toLabel: "current",
      },
    });
    try {
      const branch = compactableBranch();
      const { registry } = makeRegistry();
      const { pi } = makePi(branch);
      const { ctx, ui } = makeCtx({ branch, registry, leafId: "e6" });

      await runDebloat(pi, "timeline", ctx);

      const text = ui.notifies[0]!.msg;
      expect(text).toContain("raw: session start → current");
      expect(text).not.toContain("raw: null");
    } finally {
      spy.mockRestore();
    }
  });
});

/* ------------------------------------------- Fix J: settings default-layer target */

describe("Fix J: /debloat settings follows saveSettings' default-layer resolution", () => {
  const answers = ["fake/model-1", "high", "fake/model-1", "medium", "50000"];

  it("names and writes the global file when <cwd>/.pi does not exist", async () => {
    const env = tempEnv();
    const { registry } = makeRegistry();
    const { pi } = makePi([]);
    const { ctx, ui } = makeCtx({ branch: [], registry, selectAnswers: answers });

    await runDebloat(pi, "settings", ctx);

    const expected = path.join(env.home, ".pi", "agent", "debloat.json");
    expect(ui.notifies[0]!.msg).toContain(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.existsSync(path.join(env.cwd, ".pi", "debloat.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(expected, "utf8"))).toMatchObject({
      checkpointModel: MODEL_REF,
      checkpointThinkingLevel: "high",
      compactModel: MODEL_REF,
      compactThinkingLevel: "medium",
      maxLookbackTokens: 50_000,
    });
  });

  it("names and writes the project file when <cwd>/.pi exists", async () => {
    const env = tempEnv();
    fs.mkdirSync(path.join(env.cwd, ".pi"), { recursive: true });
    const { registry } = makeRegistry();
    const { pi } = makePi([]);
    const { ctx, ui } = makeCtx({ branch: [], registry, selectAnswers: answers });

    await runDebloat(pi, "settings", ctx);

    const expected = path.join(env.cwd, ".pi", "debloat.json");
    expect(ui.notifies[0]!.msg).toContain(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.existsSync(path.join(env.home, ".pi", "agent", "debloat.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(expected, "utf8"))).toMatchObject({
      checkpointThinkingLevel: "high",
      compactThinkingLevel: "medium",
      maxLookbackTokens: 50_000,
    });
  });
});

/* --------------------------------------------------------------- no-op paths */

describe("/compact-checkpoint no-op path", () => {
  it("notifies and makes no model call and no appendEntry when there are no checkpoints", async () => {
    const branch = conversation();
    const { registry, captured, completeCalls } = makeRegistry();
    const { pi, appended } = makePi(branch);
    const { ctx, ui } = makeCtx({ branch, registry, leafId: "e6" });

    await runCompactCheckpoint(pi, "", ctx);

    expect(captured).toHaveLength(0);
    expect(completeCalls).toHaveLength(0);
    expect(appended).toHaveLength(0);
    expect(ui.notifies[0]!.msg).toContain("no checkpoints");
  });
});

/* --------------------------- defect: createCaller must not double-bill a dispatch */

describe("createCaller: the complete() fallback must not retry a dispatched stream", () => {
  const runCall = async (options: RegistryOptions) => {
    const { registry, captured, completeCalls } = makeRegistry(options);
    const { ctx } = makeCtx({ branch: [], registry });
    const { call } = createCaller(ctx, MODEL_REF, "low");
    const promise = call({ systemPrompt: "s", userPrompt: "u", thinkingLevel: "low" });
    return { promise, captured, completeCalls };
  };

  it("falls back to complete() when the provider has no streamSimple", async () => {
    const { promise, captured, completeCalls } = await runCall({
      noStreamSimple: true,
      completeText: "from-complete",
    });

    await expect(promise).resolves.toMatchObject({ text: "from-complete" });
    expect(completeCalls).toHaveLength(1);
    expect(captured).toHaveLength(0);
  });

  it("falls back to complete() when streamSimple throws before the request is dispatched", async () => {
    const { promise, completeCalls } = await runCall({
      streamSimpleThrows: true,
      completeText: "from-complete",
    });

    await expect(promise).resolves.toMatchObject({ text: "from-complete" });
    expect(completeCalls).toHaveLength(1);
  });

  it("propagates the setup error when both streamSimple and complete() fail", async () => {
    const { promise } = await runCall({ streamSimpleThrows: true, completeThrows: true });

    await expect(promise).rejects.toThrow("streamSimple setup exploded");
  });

  it("does NOT call complete() when a dispatched stream's result() rejects", async () => {
    const { promise, captured, completeCalls } = await runCall({
      resultRejects: true,
      completeText: "must-not-be-used",
    });

    // The request was already dispatched: retrying could bill the user twice.
    await expect(promise).rejects.toThrow("stream result rejected");
    expect(completeCalls).toHaveLength(0);
    expect(captured).toHaveLength(1);
  });

  it("returns the streamed text and usage on the happy path", async () => {
    const { promise, captured, completeCalls } = await runCall({
      texts: ["hello"],
      usage: USAGE,
    });

    await expect(promise).resolves.toEqual({ text: "hello", usage: USAGE });
    expect(captured).toHaveLength(1);
    expect(completeCalls).toHaveLength(0);
  });
});
