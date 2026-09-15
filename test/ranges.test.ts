import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_CUSTOM_TYPE,
  COMPACTION_CUSTOM_TYPE,
  deriveState,
  type EntryLike,
} from "../src/state.js";
import {
  buildLookbackWindow,
  computeSpans,
  estimateTokens,
  isMessageEntry,
  isToolPairSplit,
  messageIndexMap,
  sanitizeBoundaries,
} from "../src/ranges.js";

function msg(id: string, role = "user", content: unknown = "hi"): EntryLike {
  return { id, type: "message", message: { role, content } };
}

function tokenMsg(id: string, totalTokens: number): EntryLike {
  return { id, type: "message", message: { role: "assistant", content: "x", usage: { totalTokens } } };
}

function checkpoint(id: string, afterEntryId: string, label: string): EntryLike {
  return { id, type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: { afterEntryId, label } };
}

function compaction(id: string, from: string, to: string): EntryLike {
  return {
    id,
    type: "custom",
    customType: COMPACTION_CUSTOM_TYPE,
    data: { fromAfterEntryId: from, toAfterEntryId: to, title: "t", summary: "s" },
  };
}

function nativeCompaction(id: string, firstKeptEntryId: string): EntryLike {
  return { id, type: "compaction", firstKeptEntryId, summary: "native" };
}

describe("computeSpans", () => {
  it("returns nothing when there are no active checkpoints", () => {
    const entries = [msg("m1"), msg("m2")];
    const state = deriveState(entries, "m1");
    expect(computeSpans(state, "m2")).toEqual({ compactable: [], newestRaw: null });
  });

  it("produces only newestRaw for a single active checkpoint", () => {
    const entries = [msg("m1"), msg("m2"), checkpoint("c1", "m1", "alpha")];
    const state = deriveState(entries);
    const spans = computeSpans(state, "m2");
    expect(spans.compactable).toEqual([]);
    expect(spans.newestRaw).toEqual({
      fromAfterEntryId: "m1",
      toAfterEntryId: "m2",
      fromLabel: "alpha",
      toLabel: "current",
    });
  });

  it("builds consecutive spans between active checkpoints", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      msg("m4"),
      checkpoint("ca", "m1", "alpha"),
      checkpoint("cb", "m2", "beta"),
      checkpoint("cc", "m3", "gamma"),
    ];
    const state = deriveState(entries);
    const spans = computeSpans(state, "m4");
    expect(spans.compactable).toEqual([
      { fromAfterEntryId: "m1", toAfterEntryId: "m2", fromLabel: "alpha", toLabel: "beta" },
      { fromAfterEntryId: "m2", toAfterEntryId: "m3", fromLabel: "beta", toLabel: "gamma" },
    ]);
    expect(spans.newestRaw).toEqual({
      fromAfterEntryId: "m3",
      toAfterEntryId: "m4",
      fromLabel: "gamma",
      toLabel: "current",
    });
  });

  it("ignores stale checkpoints when building spans", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      checkpoint("ca", "m1", "alpha"),
      checkpoint("cb", "m2", "beta"),
      checkpoint("cc", "m3", "gamma"),
    ];
    const state = deriveState(entries, "m2");
    const spans = computeSpans(state, "m3");
    expect(spans.compactable).toEqual([
      { fromAfterEntryId: "m2", toAfterEntryId: "m3", fromLabel: "beta", toLabel: "gamma" },
    ]);
    expect(spans.newestRaw?.fromLabel).toBe("gamma");
  });

  it("excludes spans already covered by a compaction", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      msg("m4"),
      checkpoint("ca", "m1", "alpha"),
      checkpoint("cb", "m2", "beta"),
      checkpoint("cc", "m3", "gamma"),
      compaction("k1", "m1", "m2"),
      compaction("k2", "m2", "m3"),
    ];
    const state = deriveState(entries);
    const spans = computeSpans(state, "m4");
    expect(spans.compactable).toEqual([]);
    expect(spans.newestRaw).toEqual({
      fromAfterEntryId: "m3",
      toAfterEntryId: "m4",
      fromLabel: "gamma",
      toLabel: "current",
    });
  });

  it("keeps uncompacted spans when only some are covered", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      msg("m4"),
      checkpoint("ca", "m1", "alpha"),
      checkpoint("cb", "m2", "beta"),
      checkpoint("cc", "m3", "gamma"),
      compaction("k1", "m1", "m2"),
    ];
    const state = deriveState(entries);
    const spans = computeSpans(state, "m4");
    expect(spans.compactable).toEqual([
      { fromAfterEntryId: "m2", toAfterEntryId: "m3", fromLabel: "beta", toLabel: "gamma" },
    ]);
  });

  it("excludes spans that partially overlap an accepted compaction", () => {
    // A compaction (m1, m3] was created before checkpoint "beta" was later
    // inserted at m2. Both (m1, m2] and (m2, m3] now intersect it; only
    // (m3, m4] shares an endpoint and is still offered.
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      msg("m4"),
      checkpoint("ca", "m1", "alpha"),
      checkpoint("cb", "m2", "beta"),
      checkpoint("cc", "m3", "gamma"),
      checkpoint("cd", "m4", "delta"),
      compaction("k1", "m1", "m3"),
    ];
    const state = deriveState(entries);
    const spans = computeSpans(state, "m4");
    expect(spans.compactable).toEqual([
      { fromAfterEntryId: "m3", toAfterEntryId: "m4", fromLabel: "gamma", toLabel: "delta" },
    ]);
  });

  it("still offers a span that shares only an endpoint with a compaction", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      checkpoint("ca", "m1", "alpha"),
      checkpoint("cb", "m2", "beta"),
      checkpoint("cc", "m3", "gamma"),
      compaction("k1", "m1", "m2"),
    ];
    const state = deriveState(entries);
    const spans = computeSpans(state, "m3");
    expect(spans.compactable).toEqual([
      { fromAfterEntryId: "m2", toAfterEntryId: "m3", fromLabel: "beta", toLabel: "gamma" },
    ]);
  });
});

describe("isToolPairSplit", () => {
  it("detects a boundary whose next entry is a tool result", () => {
    const entries = [msg("m1", "assistant"), msg("m2", "toolResult"), msg("m3", "assistant")];
    expect(isToolPairSplit(entries, "m1")).toBe(true);
    expect(isToolPairSplit(entries, "m2")).toBe(false);
    expect(isToolPairSplit(entries, "m3")).toBe(false);
  });

  it("treats an unknown afterEntryId as invalid", () => {
    expect(isToolPairSplit([msg("m1")], "missing")).toBe(true);
  });

  it("does not flag the last entry", () => {
    expect(isToolPairSplit([msg("m1"), msg("m2")], "m2")).toBe(false);
  });
});

describe("sanitizeBoundaries", () => {
  it("drops invalid candidates and preserves the order of the rest", () => {
    const entries = [
      msg("m1", "user"),
      msg("m2", "assistant"),
      msg("m3", "toolResult"),
      msg("m4", "user"),
      msg("m5", "assistant"),
      checkpoint("cp1", "m1", "alpha"),
    ];
    const state = deriveState(entries);
    const candidates = [
      { afterEntryId: "m1", label: "too-early" },
      { afterEntryId: "m2", label: "splits-pair" },
      { afterEntryId: "m3", label: "good-three" },
      { afterEntryId: "m4", label: "Bad Label" },
      { afterEntryId: "m4", label: "good-four" },
      { afterEntryId: "m5", label: "at-leaf" },
      { afterEntryId: "missing", label: "absent" },
      { afterEntryId: "m3", label: "duplicate" },
      { afterEntryId: "", label: "empty-id" },
    ];
    expect(sanitizeBoundaries(entries, state, "m5", candidates)).toEqual([
      { afterEntryId: "m3", label: "good-three" },
      { afterEntryId: "m4", label: "good-four" },
    ]);
  });

  it("imposes no checkpoint lower bound when there are no active checkpoints", () => {
    const entries = [msg("m1"), msg("m2")];
    const state = deriveState(entries);
    expect(sanitizeBoundaries(entries, state, "m2", [{ afterEntryId: "m1", label: "keep-me" }])).toEqual(
      [{ afterEntryId: "m1", label: "keep-me" }],
    );
  });

  it("rejects candidates positioned at or before the native cut point", () => {
    const entries = [msg("m1"), msg("m2"), msg("m3"), msg("m4")];
    const state = deriveState(entries, "m2");
    const out = sanitizeBoundaries(entries, state, "m4", [
      { afterEntryId: "m1", label: "before-cut" },
      { afterEntryId: "m2", label: "at-cut" },
      { afterEntryId: "m3", label: "after-cut" },
    ]);
    expect(out).toEqual([{ afterEntryId: "m3", label: "after-cut" }]);
  });

  it("falls back to previous behavior when the cut point id is absent from entries", () => {
    const entries = [msg("m1"), msg("m2"), msg("m3")];
    const state = deriveState(entries, "ghost-cut");
    const out = sanitizeBoundaries(entries, state, "m3", [
      { afterEntryId: "m1", label: "keep-one" },
      { afterEntryId: "m2", label: "keep-two" },
    ]);
    expect(out).toEqual([
      { afterEntryId: "m1", label: "keep-one" },
      { afterEntryId: "m2", label: "keep-two" },
    ]);
  });

  it("accepts single-word kebab labels and rejects other shapes", () => {
    const entries = [msg("m1"), msg("m2"), msg("m3"), msg("m4"), msg("m5")];
    const state = deriveState(entries);
    const out = sanitizeBoundaries(entries, state, "m5", [
      { afterEntryId: "m1", label: "plan" },
      { afterEntryId: "m2", label: "oauth-provider-settled" },
      { afterEntryId: "m3", label: "Bad_Label" },
      { afterEntryId: "m4", label: "UPPER" },
    ]);
    expect(out).toEqual([
      { afterEntryId: "m1", label: "plan" },
      { afterEntryId: "m2", label: "oauth-provider-settled" },
    ]);
  });
});

describe("estimateTokens", () => {
  it("returns 0 for a missing message", () => {
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("prefers a finite positive usage.totalTokens", () => {
    expect(estimateTokens({ role: "assistant", usage: { totalTokens: 1234 } })).toBe(1234);
  });

  it("falls back to ceil(chars / 4) for absent or non-positive usage", () => {
    expect(estimateTokens({ role: "assistant", content: "ab", usage: { totalTokens: 0 } })).toBe(1);
    expect(estimateTokens({ role: "assistant", content: "ab", usage: { totalTokens: -5 } })).toBe(1);
    expect(estimateTokens({ role: "assistant", content: "ab", usage: { totalTokens: Number.POSITIVE_INFINITY } })).toBe(1);
  });

  it("estimates from JSON-serialized content and handles missing content", () => {
    expect(estimateTokens({ role: "user", content: "x" })).toBe(1);
    expect(estimateTokens({ role: "user", content: "x".repeat(10) })).toBe(3);
    expect(estimateTokens({ role: "user", content: { a: 1 } })).toBe(2);
    expect(estimateTokens({ role: "user" })).toBe(0);
  });
});

describe("buildLookbackWindow", () => {
  it("returns the whole message list when under budget with no checkpoints", () => {
    const entries = [msg("m1"), msg("m2"), msg("m3")];
    const state = deriveState(entries);
    const window = buildLookbackWindow(entries, state, 100_000);
    expect(window.entries.map((e) => e.id)).toEqual(["m1", "m2", "m3"]);
    expect(window.startAfterEntryId).toBe(null);
    expect(window.truncated).toBe(false);
    expect(window.tokens).toBe(
      estimateTokens(entries[0]?.message) + estimateTokens(entries[1]?.message) + estimateTokens(entries[2]?.message),
    );
  });

  it("caps the window at maxTokens while always keeping the newest message", () => {
    const entries = [
      tokenMsg("m1", 30_000),
      tokenMsg("m2", 30_000),
      tokenMsg("m3", 30_000),
      tokenMsg("m4", 30_000),
      tokenMsg("m5", 30_000),
    ];
    const state = deriveState(entries);
    const window = buildLookbackWindow(entries, state, 100_000);
    // Contract: accumulate newest -> oldest, stop once accumulated tokens exceed the cap.
    // m5(30k) + m4(60k) + m3(90k) + m2(120k > 100k) => stop, m2 stays as the crossing message.
    expect(window.entries.map((e) => e.id)).toEqual(["m2", "m3", "m4", "m5"]);
    expect(window.tokens).toBe(120_000);
    expect(window.truncated).toBe(true);
    expect(window.startAfterEntryId).toBe(null);
  });

  it("starts the window strictly after the newest active checkpoint", () => {
    const entries = [
      tokenMsg("m1", 10),
      tokenMsg("m2", 10),
      tokenMsg("m3", 10),
      checkpoint("cp1", "m2", "anchor"),
      msg("trailing"),
    ];
    const state = deriveState(entries);
    const window = buildLookbackWindow(entries, state, 100_000);
    expect(window.entries.map((e) => e.id)).toEqual(["m3", "trailing"]);
    expect(window.startAfterEntryId).toBe("m2");
    expect(window.truncated).toBe(false);
  });

  it("never looks back before the newest active checkpoint, even when truncated", () => {
    const entries = [
      tokenMsg("m1", 50_000),
      checkpoint("cp1", "m1", "anchor"),
      tokenMsg("m2", 50_000),
      tokenMsg("m3", 50_000),
      tokenMsg("m4", 50_000),
    ];
    const state = deriveState(entries);
    const window = buildLookbackWindow(entries, state, 60_000);
    expect(window.entries.map((e) => e.id)).toEqual(["m3", "m4"]);
    expect(window.startAfterEntryId).toBe("m1");
    expect(window.truncated).toBe(true);
  });

  it("only considers message entries", () => {
    const entries: EntryLike[] = [
      msg("m1"),
      { id: "k1", type: "compaction", firstKeptEntryId: "unknown-cut", summary: "native" },
      { id: "s1", type: "branchSummary", summary: "branch" },
      msg("m2"),
    ];
    const state = deriveState(entries);
    const window = buildLookbackWindow(entries, state, 100_000);
    expect(window.entries.map((e) => e.id)).toEqual(["m1", "m2"]);
  });

  it("starts strictly after the native cut point when there is no active checkpoint", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      msg("m4"),
      nativeCompaction("n1", "m3"),
    ];
    const state = deriveState(entries);
    const window = buildLookbackWindow(entries, state, 100_000);
    expect(window.entries.map((e) => e.id)).toEqual(["m4"]);
    expect(window.startAfterEntryId).toBe("m3");
    expect(window.truncated).toBe(false);
  });

  it("keeps a newer active checkpoint as the anchor while still excluding pre-cut messages", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      msg("m4"),
      nativeCompaction("n1", "m2"),
      checkpoint("cp1", "m3", "anchor"),
    ];
    const state = deriveState(entries);
    const window = buildLookbackWindow(entries, state, 100_000);
    expect(window.entries.map((e) => e.id)).toEqual(["m4"]);
    expect(window.startAfterEntryId).toBe("m3");
  });

  it("falls back to previous behavior when the cut point id is absent from entries", () => {
    const entries = [msg("m1"), msg("m2")];
    const state = deriveState(entries, "ghost-cut");
    const window = buildLookbackWindow(entries, state, 100_000);
    expect(window.entries.map((e) => e.id)).toEqual(["m1", "m2"]);
    expect(window.startAfterEntryId).toBe(null);
  });

  it("excludes message ranges already covered by an accepted compaction", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      msg("m4"),
      compaction("k1", "m1", "m3"),
    ];
    const state = deriveState(entries);
    const window = buildLookbackWindow(entries, state, 100_000);
    // (m1, m3] covers m2 and m3; m1 is the exclusive anchor and stays raw.
    expect(window.entries.map((e) => e.id)).toEqual(["m1", "m4"]);
  });

  it("ignores a compaction whose endpoints are absent from entries", () => {
    const entries = [msg("m1"), msg("m2"), compaction("k1", "ghost-from", "m1")];
    const state = deriveState(entries);
    const window = buildLookbackWindow(entries, state, 100_000);
    expect(window.entries.map((e) => e.id)).toEqual(["m1", "m2"]);
  });
});

describe("messageIndexMap", () => {
  it("emits one slot per LLM-visible message and skips everything else", () => {
    const entries: EntryLike[] = [
      { id: "u1", type: "message", message: { role: "user", content: "hi" } },
      { id: "cp", type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: {} },
      { id: "a1", type: "message", message: { role: "assistant", content: "yo" } },
      { id: "k1", type: "compaction", firstKeptEntryId: "a1", summary: "s" },
      { id: "b1", type: "branchSummary", summary: "bs" },
      { id: "cm1", type: "customMessage", message: { role: "custom", content: "c" } },
      { id: "model", type: "model-change", modelId: "x" },
      { id: "think", type: "thinking-level" },
      { id: "ci", type: "custom", message: { role: "custom", content: "c2" } },
    ];
    expect(messageIndexMap(entries)).toEqual(["u1", "a1", "k1", "b1", "cm1", "ci"]);
  });

  it("returns an empty map when no entry contributes a message", () => {
    const entries: EntryLike[] = [
      { id: "cp", type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: {} },
      { id: "model", type: "model-change" },
    ];
    expect(messageIndexMap(entries)).toEqual([]);
  });
});

describe("isMessageEntry", () => {
  it("is true only for message entries carrying a message", () => {
    expect(isMessageEntry({ id: "a", type: "message", message: { role: "user" } })).toBe(true);
    expect(isMessageEntry({ id: "b", type: "message" })).toBe(false);
    expect(isMessageEntry({ id: "c", type: "custom", message: { role: "user" } })).toBe(false);
  });
});
