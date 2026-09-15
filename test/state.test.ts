import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_CUSTOM_TYPE,
  COMPACTION_CUSTOM_TYPE,
  TOMBSTONE_CUSTOM_TYPE,
  deriveState,
  type EntryLike,
} from "../src/state.js";

function msg(id: string, role = "user", content: unknown = "hi"): EntryLike {
  return { id, type: "message", message: { role, content } };
}

function checkpoint(id: string, afterEntryId: string, label: string): EntryLike {
  return { id, type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: { afterEntryId, label } };
}

function compaction(
  id: string,
  from: string,
  to: string,
  title = "title",
  summary = "summary",
): EntryLike {
  return {
    id,
    type: "custom",
    customType: COMPACTION_CUSTOM_TYPE,
    data: { fromAfterEntryId: from, toAfterEntryId: to, title, summary },
  };
}

function tombstone(id: string): EntryLike {
  return { id, type: "custom", customType: TOMBSTONE_CUSTOM_TYPE, data: { removedCheckpoints: 0 } };
}

function nativeCompaction(id: string, firstKeptEntryId: string): EntryLike {
  return { id, type: "compaction", firstKeptEntryId, summary: "native" };
}

describe("deriveState", () => {
  it("returns an empty state for an empty entry array", () => {
    expect(deriveState([])).toEqual({
      checkpoints: [],
      activeCheckpoints: [],
      compactions: [],
      removedCheckpointCount: 0,
      hasTombstone: false,
      nativeCutPointId: null,
    });
  });

  it("parses checkpoints and orders them by logical (afterEntryId) position", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      checkpoint("c-late", "m3", "third"),
      checkpoint("c-early", "m1", "first"),
    ];
    const state = deriveState(entries);
    expect(state.checkpoints).toEqual([
      { entryId: "c-early", afterEntryId: "m1", label: "first", stale: false },
      { entryId: "c-late", afterEntryId: "m3", label: "third", stale: false },
    ]);
    expect(state.activeCheckpoints.map((c) => c.label)).toEqual(["first", "third"]);
  });

  it("marks checkpoints before the native cut point stale, keeps later ones active", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      checkpoint("c1", "m1", "one"),
      checkpoint("c3", "m3", "three"),
    ];
    const state = deriveState(entries, "m2");
    expect(state.nativeCutPointId).toBe("m2");
    expect(state.checkpoints.map((c) => [c.label, c.stale])).toEqual([
      ["one", true],
      ["three", false],
    ]);
    expect(state.activeCheckpoints.map((c) => c.label)).toEqual(["three"]);
  });

  it("derives the native cut point from the latest native compaction entry", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      nativeCompaction("n1", "m2"),
      nativeCompaction("n2", "m3"),
      checkpoint("c1", "m1", "one"),
    ];
    const state = deriveState(entries);
    expect(state.nativeCutPointId).toBe("m3");
    expect(state.checkpoints[0]?.stale).toBe(true);
  });

  it("has no staleness when there is no native cut point", () => {
    const entries = [msg("m1"), checkpoint("c1", "m1", "one")];
    expect(deriveState(entries, null).checkpoints[0]?.stale).toBe(false);
    expect(deriveState(entries).checkpoints[0]?.stale).toBe(false);
  });

  it("marks a checkpoint with an unknown afterEntryId stale", () => {
    const entries = [msg("m1"), checkpoint("c1", "does-not-exist", "one")];
    const state = deriveState(entries, "m1");
    expect(state.checkpoints[0]?.stale).toBe(true);
    expect(state.activeCheckpoints).toEqual([]);
  });

  it("lets a tombstone ignore earlier checkpoints while later ones stay active", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      checkpoint("c1", "m1", "one"),
      tombstone("t1"),
      checkpoint("c2", "m2", "two"),
    ];
    const state = deriveState(entries);
    expect(state.hasTombstone).toBe(true);
    expect(state.removedCheckpointCount).toBe(1);
    expect(state.checkpoints.map((c) => c.label)).toEqual(["two"]);
    expect(state.activeCheckpoints.map((c) => c.label)).toEqual(["two"]);
  });

  it("accumulates removedCheckpointCount across multiple tombstones", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      msg("m4"),
      checkpoint("c1", "m1", "one"),
      checkpoint("c2", "m2", "two"),
      tombstone("t1"),
      checkpoint("c3", "m3", "three"),
      tombstone("t2"),
      checkpoint("c4", "m4", "four"),
    ];
    const state = deriveState(entries);
    expect(state.removedCheckpointCount).toBe(3);
    expect(state.hasTombstone).toBe(true);
    expect(state.checkpoints.map((c) => c.label)).toEqual(["four"]);
  });

  it("accepts adjacent compaction spans and rejects overlapping or duplicate ones", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      msg("m4"),
      compaction("k1", "m1", "m2"),
      compaction("k2", "m2", "m3"),
      compaction("k3", "m1", "m2"),
      compaction("k4", "m2", "m4"),
    ];
    const state = deriveState(entries);
    expect(state.compactions.map((c) => c.entryId)).toEqual(["k1", "k2"]);
  });

  it("orders compactions by their logical span position, not append order", () => {
    const entries = [
      msg("m1"),
      msg("m2"),
      msg("m3"),
      msg("m4"),
      compaction("k-late", "m3", "m4"),
      compaction("k-early", "m1", "m2"),
    ];
    expect(deriveState(entries).compactions.map((c) => c.entryId)).toEqual(["k-early", "k-late"]);
  });

  it("preserves compaction usage when present and omits the key otherwise", () => {
    const withUsage: EntryLike = {
      id: "k1",
      type: "custom",
      customType: COMPACTION_CUSTOM_TYPE,
      data: {
        fromAfterEntryId: "m1",
        toAfterEntryId: "m2",
        title: "t",
        summary: "s",
        usage: { totalTokens: 42 },
      },
    };
    const state = deriveState([msg("m1"), msg("m2"), withUsage, compaction("k2", "m2", "m3")]);
    expect(state.compactions[0]?.usage).toEqual({ totalTokens: 42 });
    expect("usage" in (state.compactions[1] ?? {})).toBe(false);
  });

  it("skips malformed custom entries without throwing", () => {
    const entries: EntryLike[] = [
      { id: "x1", type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: null },
      { id: "x2", type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: { afterEntryId: 5, label: "a" } },
      { id: "x3", type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: { afterEntryId: "m1" } },
      { id: "x4", type: "custom", customType: CHECKPOINT_CUSTOM_TYPE, data: { afterEntryId: "m1", label: "" } },
      { id: "x5", type: "custom", customType: COMPACTION_CUSTOM_TYPE, data: { fromAfterEntryId: "m1" } },
      { id: "x6", type: "custom", customType: COMPACTION_CUSTOM_TYPE, data: {} },
      { id: "x7", type: "custom" },
      msg("m1"),
    ];
    let state: ReturnType<typeof deriveState> | undefined;
    expect(() => {
      state = deriveState(entries);
    }).not.toThrow();
    expect(state?.checkpoints).toEqual([]);
    expect(state?.compactions).toEqual([]);
  });

  it("treats a tombstone as effective even when its data is malformed", () => {
    const entries: EntryLike[] = [
      msg("m1"),
      checkpoint("c1", "m1", "one"),
      { id: "t1", type: "custom", customType: TOMBSTONE_CUSTOM_TYPE, data: "not-an-object" },
    ];
    const state = deriveState(entries);
    expect(state.hasTombstone).toBe(true);
    expect(state.removedCheckpointCount).toBe(1);
    expect(state.checkpoints).toEqual([]);
  });

  it("rebuilds state from a plain entry array without mutating it", () => {
    const entries = [msg("m1"), checkpoint("c1", "m1", "one"), tombstone("t1")];
    const snapshot = JSON.stringify(entries);
    const state = deriveState(entries);
    expect(JSON.stringify(entries)).toBe(snapshot);
    expect(state.hasTombstone).toBe(true);
    expect(state.removedCheckpointCount).toBe(1);
  });
});
