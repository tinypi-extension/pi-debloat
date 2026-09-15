import { describe, expect, it } from "vitest";

import {
  DEBLOAT_PREFIX,
  applyCompactions,
  formatSummaryContent,
  rebuildMessages,
  type IndexedMessage,
} from "../src/context-build.js";
import type { Checkpoint, Compaction, DebloatState, MessageLike } from "../src/state.js";

function compaction(fromAfterEntryId: string, toAfterEntryId: string, title = "t", summary = "s"): Compaction {
  return { entryId: `k-${fromAfterEntryId}-${toAfterEntryId}`, fromAfterEntryId, toAfterEntryId, title, summary };
}

function stateWith(compactions: Compaction[], checkpoints: Checkpoint[] = []): DebloatState {
  return {
    checkpoints,
    activeCheckpoints: checkpoints.filter((c) => !c.stale),
    compactions,
    removedCheckpointCount: 0,
    hasTombstone: false,
    nativeCutPointId: null,
  };
}

function item(entryId: string | null): IndexedMessage {
  return { entryId, message: { role: "user", content: entryId === null ? "null-entry" : `msg-${entryId}` } };
}

function indexed(...entryIds: (string | null)[]): IndexedMessage[] {
  return entryIds.map((id) => item(id));
}

describe("formatSummaryContent", () => {
  it("builds the exact summary shape with a literal arrow", () => {
    const content = formatSummaryContent("a1", "b2", "my-title", "line one\nline two");
    expect(content).toBe("[Debloat summary a1→b2: my-title]\n\nline one\nline two");
    expect(DEBLOAT_PREFIX).toBe("[Debloat summary ");
  });
});

describe("applyCompactions", () => {
  it("replaces a compacted span with exactly one synthetic message at the earliest dropped position", () => {
    const entryOrder = ["e0", "e1", "e2", "e3", "e4"];
    const items = indexed("e0", "e1", "e2", "e3", "e4");
    const state = stateWith([compaction("e1", "e3", "mid", "the summary")]);

    const out = applyCompactions(items, state, entryOrder);

    expect(out.map((i) => i.entryId)).toEqual(["e0", "e1", "e3", "e4"]);
    expect(out.map((i) => i.message.content)).toEqual([
      "msg-e0",
      "msg-e1",
      formatSummaryContent("e1", "e3", "mid", "the summary"),
      "msg-e4",
    ]);
    expect(out[2]!.message.role).toBe("user");
    expect(typeof out[2]!.message.timestamp).toBe("number");
  });

  it("keeps message order stable and drops every span member", () => {
    const entryOrder = ["e0", "e1", "e2", "e3", "e4", "e5"];
    const items = indexed("e0", "e1", "e2", "e3", "e4", "e5");
    const state = stateWith([compaction("e1", "e4")]);

    const out = applyCompactions(items, state, entryOrder);
    const contents = out.map((i) => i.message.content);

    expect(contents).not.toContain("msg-e2");
    expect(contents).not.toContain("msg-e3");
    expect(contents).not.toContain("msg-e4");
    expect(contents[0]).toBe("msg-e0");
    expect(contents[1]).toBe("msg-e1");
    expect(contents[2]).toContain(DEBLOAT_PREFIX);
    expect(contents[3]).toBe("msg-e5");
  });

  it("applies two adjacent non-overlapping spans", () => {
    const entryOrder = ["e0", "e1", "e2", "e3"];
    const items = indexed("e0", "e1", "e2", "e3");
    const state = stateWith([compaction("e0", "e1", "first"), compaction("e1", "e2", "second")]);

    const out = applyCompactions(items, state, entryOrder);

    expect(out.map((i) => i.entryId)).toEqual(["e0", "e1", "e2", "e3"]);
    expect(out[1]!.message.content).toBe(formatSummaryContent("e0", "e1", "first", "s"));
    expect(out[2]!.message.content).toBe(formatSummaryContent("e1", "e2", "second", "s"));
  });

  it("leaves the newest span untouched", () => {
    const entryOrder = ["e0", "e1", "e2", "e3", "e4"];
    const items = indexed("e0", "e1", "e2", "e3", "e4");
    const state = stateWith([compaction("e0", "e1")]);

    const out = applyCompactions(items, state, entryOrder);
    expect(out.map((i) => i.message.content)).toContain("msg-e3");
    expect(out.map((i) => i.message.content)).toContain("msg-e4");
  });

  it("skips a compaction whose endpoints are missing from the entry order", () => {
    const entryOrder = ["e0", "e1", "e2"];
    const items = indexed("e0", "e1", "e2");
    const state = stateWith([compaction("ghost", "e2")]);

    expect(applyCompactions(items, state, entryOrder)).toEqual(items);
  });

  it("skips a compaction whose span contains no messages", () => {
    const entryOrder = ["e0", "e1", "e2"];
    const items = indexed("e0", "e2"); // no item maps to e1
    const state = stateWith([compaction("e0", "e1")]);

    expect(applyCompactions(items, state, entryOrder)).toEqual(items);
  });

  it("returns the input unchanged when there are no compactions", () => {
    const entryOrder = ["e0", "e1"];
    const items = indexed("e0", "e1");
    expect(applyCompactions(items, stateWith([]), entryOrder)).toEqual(items);
  });

  it("leaves items with a null entry id outside every span", () => {
    const entryOrder = ["e0", "e1", "e2"];
    const items = indexed("e0", null, "e2");
    const state = stateWith([compaction("e0", "e2")]);

    const out = applyCompactions(items, state, entryOrder);
    expect(out.map((i) => i.entryId)).toEqual(["e0", null, "e2"]);
    expect(out[1]!.message.content).toBe("null-entry");
    expect(out[2]!.message.content).toContain(DEBLOAT_PREFIX);
  });
});

describe("rebuildMessages", () => {
  function message(text: string): MessageLike {
    return { role: "user", content: text };
  }

  it("returns null when the index map length disagrees with the message list", () => {
    const messages = [message("a")];
    const entryOrder = ["e0", "e1"];
    expect(rebuildMessages(messages, ["e0", "e1"], stateWith([]), entryOrder)).toBeNull();
    expect(rebuildMessages([], ["e0"], stateWith([]), entryOrder)).toBeNull();
    expect(rebuildMessages([], [], stateWith([]), entryOrder)).toEqual({ messages: [], applied: 0 });
  });

  it("zips messages with entry ids and reports the applied count", () => {
    const messages = [message("m0"), message("m1"), message("m2"), message("m3")];
    const indexMap = ["e0", "e1", "e2", "e3"];
    const entryOrder = ["e0", "e1", "e2", "e3"];
    const state = stateWith([compaction("e0", "e2"), compaction("ghost", "e3")]);

    const result = rebuildMessages(messages, indexMap, state, entryOrder);

    expect(result).not.toBeNull();
    expect(result!.applied).toBe(1);
    expect(result!.messages).toHaveLength(3);
    expect(result!.messages[0]!.content).toBe("m0");
    expect(result!.messages[1]!.content).toBe(formatSummaryContent("e0", "e2", "t", "s"));
    expect(result!.messages[2]!.content).toBe("m3");
  });

  it("reports zero applied when nothing matches", () => {
    const messages = [message("m0"), message("m1")];
    const result = rebuildMessages(messages, [null, null], stateWith([compaction("e0", "e1")]), ["e0", "e1"]);
    expect(result).toEqual({ messages, applied: 0 });
  });
});
