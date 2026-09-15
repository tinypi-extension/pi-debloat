import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EntryLike } from "../src/state.js";
import {
  COMPACT_MAX_CHARS_PER_ENTRY,
  formatTranscript,
  parseJsonOutput,
  readSkillFile,
  requestJson,
  truncateBody,
  validateCheckpoints,
  validateCompact,
  type LlmCall,
} from "../src/llm.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "debloat-llm-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseJsonOutput", () => {
  it("parses a bare JSON array", () => {
    const result = parseJsonOutput<{ afterEntryId: string }[]>('[{"afterEntryId":"a"}]');
    expect(result).toEqual({ ok: true, value: [{ afterEntryId: "a" }] });
  });

  it("parses a bare JSON object", () => {
    expect(parseJsonOutput('{"title":"t","summary":"s"}')).toEqual({
      ok: true,
      value: { title: "t", summary: "s" },
    });
  });

  it("strips markdown code fences", () => {
    const text = '```json\n{"title":"t","summary":"s"}\n```';
    expect(parseJsonOutput(text)).toEqual({ ok: true, value: { title: "t", summary: "s" } });
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const text = 'Sure, here is the plan:\n[{"a":1}]\nLet me know if that works.';
    expect(parseJsonOutput(text)).toEqual({ ok: true, value: [{ a: 1 }] });
  });

  it("handles nested brackets, braces and braces inside strings", () => {
    const text = '{"a":{"b":[1,{"c":"}"}]},"d":"["}';
    expect(parseJsonOutput(text)).toEqual({ ok: true, value: { a: { b: [1, { c: "}" }] }, d: "[" } });
  });

  it("handles escaped quotes inside strings", () => {
    const text = '{"a":"he said \\"hi\\""}';
    expect(parseJsonOutput(text)).toEqual({ ok: true, value: { a: 'he said "hi"' } });
  });

  it("never throws on malformed JSON and returns a readable error", () => {
    const result = parseJsonOutput("{not json}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it("rejects empty and whitespace-only input", () => {
    expect(parseJsonOutput("").ok).toBe(false);
    expect(parseJsonOutput("   \n  ").ok).toBe(false);
  });

  it("rejects garbage without a JSON block", () => {
    expect(parseJsonOutput("no json here").ok).toBe(false);
  });

  it("rejects a truncated balanced-looking block", () => {
    expect(parseJsonOutput('{"a": [1, 2').ok).toBe(false);
  });
});

describe("validateCheckpoints", () => {
  it("accepts an array of checkpoint objects and strips extra fields", () => {
    expect(
      validateCheckpoints([
        { afterEntryId: "a", label: "alpha", extra: 1 },
        { afterEntryId: "b", label: "beta" },
      ]),
    ).toEqual([
      { afterEntryId: "a", label: "alpha" },
      { afterEntryId: "b", label: "beta" },
    ]);
  });

  it("accepts an empty array", () => {
    expect(validateCheckpoints([])).toEqual([]);
  });

  it("rejects non-arrays", () => {
    expect(typeof validateCheckpoints("nope")).toBe("string");
    expect(typeof validateCheckpoints({ afterEntryId: "a", label: "b" })).toBe("string");
    expect(typeof validateCheckpoints(null)).toBe("string");
  });

  it("rejects items that are not objects", () => {
    expect(typeof validateCheckpoints(["x"])).toBe("string");
  });

  it("rejects missing or empty string fields", () => {
    expect(typeof validateCheckpoints([{ afterEntryId: "", label: "a" }])).toBe("string");
    expect(typeof validateCheckpoints([{ afterEntryId: "a", label: "" }])).toBe("string");
    expect(typeof validateCheckpoints([{ afterEntryId: 1, label: "a" }])).toBe("string");
    expect(typeof validateCheckpoints([{ afterEntryId: "a" }])).toBe("string");
  });
});

describe("validateCompact", () => {
  it("accepts one object with non-empty title and summary", () => {
    expect(validateCompact({ title: "t", summary: "s", extra: 1 })).toEqual({
      title: "t",
      summary: "s",
    });
  });

  it("rejects arrays, primitives and null", () => {
    expect(typeof validateCompact(["t", "s"])).toBe("string");
    expect(typeof validateCompact("t")).toBe("string");
    expect(typeof validateCompact(null)).toBe("string");
  });

  it("rejects missing or empty fields", () => {
    expect(typeof validateCompact({ title: "", summary: "s" })).toBe("string");
    expect(typeof validateCompact({ title: "t", summary: "" })).toBe("string");
    expect(typeof validateCompact({ title: "t" })).toBe("string");
    expect(typeof validateCompact({ title: 1, summary: "s" })).toBe("string");
  });
});

describe("requestJson", () => {
  const request = { systemPrompt: "sys", userPrompt: "user", thinkingLevel: "low" };

  it("returns the validated value on the first valid attempt", async () => {
    let calls = 0;
    const call: LlmCall = async () => {
      calls++;
      return { text: '{"title":"t","summary":"s"}', usage: { totalTokens: 5 } };
    };
    const result = await requestJson(call, request, validateCompact);
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: true, value: { title: "t", summary: "s" }, usage: { totalTokens: 5 } });
  });

  it("retries once with the validation error and first response, then succeeds", async () => {
    const requests: { userPrompt: string }[] = [];
    const responses = ["not json at all", '{"title":"t","summary":"s"}'];
    const call: LlmCall = async (req) => {
      requests.push(req);
      return { text: responses[requests.length - 1]! };
    };
    const result = await requestJson(call, request, validateCompact);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.userPrompt).toContain("user");
    // the corrective prompt must carry both the failure reason and the first response
    const firstError = parseJsonOutput("not json at all");
    if (!firstError.ok) expect(requests[1]!.userPrompt).toContain(firstError.error);
    expect(requests[1]!.userPrompt).toContain("not json at all");
    expect(requests[1]!.userPrompt.length).toBeGreaterThan(requests[0]!.userPrompt.length);
    expect(result.ok).toBe(true);
  });

  it("retries when validation (not parsing) fails", async () => {
    const responses = ['{"title":"","summary":"s"}', '{"title":"t","summary":"s"}'];
    let calls = 0;
    const call: LlmCall = async () => ({ text: responses[calls++]! });
    const result = await requestJson(call, request, validateCompact);
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false after a retry that also fails", async () => {
    let calls = 0;
    const call: LlmCall = async () => {
      calls++;
      return { text: "still garbage" };
    };
    const result = await requestJson(call, request, validateCompact);
    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it("catches a throwing call and never escapes", async () => {
    let calls = 0;
    const call: LlmCall = async () => {
      calls++;
      throw new Error("provider exploded");
    };
    const result = await requestJson(call, request, validateCompact);
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("provider exploded");
  });

  it("catches a rejection from call during the retry", async () => {
    let calls = 0;
    const call: LlmCall = async () => {
      calls++;
      if (calls === 1) return { text: "garbage" };
      throw new Error("retry boom");
    };
    const result = await requestJson(call, request, validateCompact);
    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("retry boom");
  });
});

describe("truncateBody", () => {
  it("returns short bodies unchanged", () => {
    expect(truncateBody("hello", 10)).toBe("hello");
    expect(truncateBody("hello", 5)).toBe("hello");
  });

  it("truncates long bodies with a k-chars sentinel", () => {
    const result = truncateBody("x".repeat(5000), 2000);
    expect(result.startsWith("x".repeat(2000))).toBe(true);
    expect(result).toContain("[truncated 3k chars]");
  });

  it("returns an empty string for a non-positive cap", () => {
    expect(truncateBody("hello", 0)).toBe("");
  });
});

describe("formatTranscript", () => {
  function entry(id: string, role: string, content: unknown): EntryLike {
    return { id, type: "message", message: { role, content } };
  }

  it("formats one line per entry with mapped roles", () => {
    const entries: EntryLike[] = [
      entry("a", "user", "hi"),
      entry("b", "assistant", "yo"),
      entry("c", "toolResult", "tool out"),
      entry("d", "custom", "custom out"),
      entry("e", "system", "unknown role"),
    ];
    const lines = formatTranscript(entries, { maxCharsPerEntry: 1000 }).split("\n");
    expect(lines[0]).toMatch(/^\[node a\] USER  hi$/);
    expect(lines[1]).toMatch(/^\[node b\] AI  yo/);
    expect(lines[2]).toMatch(/^\[node c\] TOOL  tool out/);
    expect(lines[3]).toMatch(/^\[node d\] CUSTOM  custom out/);
    expect(lines[4]).toMatch(/^\[node e\] USER  unknown role/);
  });

  it("marks the final entry with a HEAD arrow", () => {
    const entries = [entry("a", "user", "hi"), entry("b", "assistant", "yo")];
    const out = formatTranscript(entries, { maxCharsPerEntry: 1000 });
    expect(out).not.toContain("[node a] USER  hi  ← HEAD");
    expect(out).toContain("[node b] AI  yo  ← HEAD");
  });

  it("collapses multi-line bodies onto a single line", () => {
    const entries = [entry("a", "user", "line one\n  line two\tline three")];
    const out = formatTranscript(entries, { maxCharsPerEntry: 1000 });
    expect(out).toContain("[node a] USER  line one line two line three");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("joins text content blocks with spaces and renders tool calls", () => {
    const entries: EntryLike[] = [
      entry("a", "assistant", [
        { type: "text", text: "first" },
        { type: "toolCall", name: "read" },
        { type: "text", text: "second" },
      ]),
    ];
    expect(formatTranscript(entries, { maxCharsPerEntry: 1000 })).toContain(
      "[node a] AI  first [tool read {}] second",
    );
  });

  it("renders tool-call name and compact JSON arguments on one line", () => {
    const entries: EntryLike[] = [
      entry("a", "assistant", [
        { type: "text", text: "reading" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "src/a.ts", limit: 20 } },
      ]),
    ];
    const out = formatTranscript(entries, { maxCharsPerEntry: 1000 });
    expect(out).toContain('[tool read {"path":"src/a.ts","limit":20}]');
    expect(out.split("\n")).toHaveLength(1);
  });

  it("never emits a raw newline from tool-call arguments", () => {
    const entries: EntryLike[] = [
      entry("a", "assistant", [
        { type: "toolCall", name: "bash", arguments: { command: "line one\nline two" } },
      ]),
    ];
    const out = formatTranscript(entries, { maxCharsPerEntry: 1000 });
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain('[tool bash {"command":"line one\\nline two"}]');
  });

  it("truncates oversized tool arguments while keeping a single line", () => {
    const entries: EntryLike[] = [
      entry("a", "assistant", [
        { type: "toolCall", name: "write", arguments: { body: "x".repeat(2000) } },
      ]),
    ];
    const out = formatTranscript(entries, { maxCharsPerEntry: 5000 });
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("[tool write ");
    expect(out.length).toBeLessThan(1000);
  });

  it("drops thinking blocks from the transcript", () => {
    const entries: EntryLike[] = [
      entry("a", "assistant", [
        { type: "thinking", thinking: "secret-chain-of-thought" },
        { type: "text", text: "visible" },
      ]),
    ];
    const out = formatTranscript(entries, { maxCharsPerEntry: 1000 });
    expect(out).toContain("visible");
    expect(out).not.toContain("secret-chain-of-thought");
  });

  it("keeps a long entry intact at the compactor budget while the default truncates", () => {
    const long = "z".repeat(5000);
    const entries = [entry("a", "user", long)];
    expect(COMPACT_MAX_CHARS_PER_ENTRY).toBe(20000);
    expect(formatTranscript(entries)).toContain("[truncated 3k chars]");
    const compactorView = formatTranscript(entries, { maxCharsPerEntry: COMPACT_MAX_CHARS_PER_ENTRY });
    expect(compactorView).toContain(long);
    expect(compactorView).not.toContain("[truncated");
  });

  it("truncates long bodies with the sentinel", () => {
    const entries = [entry("a", "user", "z".repeat(5000))];
    const out = formatTranscript(entries, { maxCharsPerEntry: 1000 });
    expect(out).toContain("[truncated 4k chars]");
  });

  it("returns an empty string for no entries", () => {
    expect(formatTranscript([])).toBe("");
  });
});

describe("readSkillFile", () => {
  it("reads a skill from an injected baseDir", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "compact.md"), "# Compactor\nbody\n", "utf8");
    expect(readSkillFile("compact.md", dir)).toContain("Compactor");
  });

  it("returns an empty string for a missing skill file", () => {
    const dir = makeTempDir();
    expect(readSkillFile("does-not-exist.md", dir)).toBe("");
  });

  it("resolves the bundled skills directory by default", () => {
    expect(readSkillFile("compact.md")).toContain("compactor");
    expect(readSkillFile("nope-missing.md")).toBe("");
  });
});
