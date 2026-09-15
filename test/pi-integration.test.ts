/**
 * Real-pi integration test for the load-bearing alignment assumption of the
 * Debloat design (SPEC success criterion 5).
 *
 * The `context` handler in `src/index.ts` zips pi's `context`-event message list
 * against `messageIndexMap(ctx.sessionManager.buildContextEntries())`. If those
 * lengths ever disagree, `rebuildMessages` returns `null` and Debloat silently
 * does nothing. This test drives pi's *own* session implementation (the values
 * are exported from `@earendil-works/pi-coding-agent`) in a temp directory and
 * compares Debloat's map against the projection pi itself uses for the same
 * branch, then checks that a compaction span actually gets applied.
 *
 * No network, no API keys, no model calls: only `SessionManager` + the pure
 * projection helpers.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildContextEntries,
  SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";

import { rebuildMessages } from "../src/context-build.js";
import debloatExtension from "../src/index.js";
import { messageIndexMap } from "../src/ranges.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  COMPACTION_CUSTOM_TYPE,
  deriveState,
  type EntryLike,
  type MessageLike,
} from "../src/state.js";

const USAGE: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp: number): UserMessage {
  return { role: "user", content: text, timestamp };
}

function assistantText(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    usage: USAGE,
    stopReason: "stop",
    timestamp,
  };
}

function assistantToolCall(toolCallId: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "a.ts" } }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    usage: USAGE,
    stopReason: "toolUse",
    timestamp,
  };
}

function toolResult(toolCallId: string, timestamp: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: "file contents" }],
    isError: false,
    timestamp,
  };
}

const TEMP_DIRS: string[] = [];

/** Real on-disk session in a throwaway directory (never ~/.pi, never ./.pi). */
function tempSession(): SessionManager {
  const dir = mkdtempSync(join(tmpdir(), "pi-debloat-integration-"));
  TEMP_DIRS.push(dir);
  return SessionManager.create(dir, dir);
}

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * pi's own projection for the current branch, via all three exported entry
 * points. `agent.state.messages` (which is what the `context` handler receives,
 * structured-cloned) is assigned from `buildSessionContext().messages`, and the
 * entries it is derived from are `buildContextEntries()`.
 */
function piProjection(sm: SessionManager) {
  const entries = sm.buildContextEntries();
  const viaManager = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
  const viaStandalone = buildContextEntries(sm.getEntries(), sm.getLeafId()).flatMap((entry) =>
    sessionEntryToContextMessages(entry),
  );
  const contextMessages = sm.buildSessionContext().messages;
  return { entries, viaManager, viaStandalone, contextMessages };
}

/** The exact inputs `src/index.ts` feeds to `rebuildMessages`. */
function debloatInputs(sm: SessionManager) {
  const { entries, viaManager, viaStandalone, contextMessages } = piProjection(sm);
  return {
    entries,
    projected: viaManager,
    viaStandalone,
    contextMessages,
    indexMap: messageIndexMap(entries as unknown as EntryLike[]),
    state: deriveState(sm.getBranch() as unknown as EntryLike[]),
    entryOrder: entries.map((entry) => entry.id),
  };
}

function rebuild(sm: SessionManager) {
  const a = debloatInputs(sm);
  const result = rebuildMessages(
    a.projected as unknown as MessageLike[],
    a.indexMap,
    a.state,
    a.entryOrder,
  );
  return { ...a, result };
}

type ContextHandler = (
  event: { messages: MessageLike[] },
  ctx: unknown,
) => { messages: MessageLike[] } | undefined;

/** Install the real extension and capture the `context` handler. */
function installContextHandler(): ContextHandler {
  let handler: ContextHandler | undefined;
  const pi = {
    registerCommand() {},
    on(event: string, fn: ContextHandler) {
      if (event === "context") handler = fn;
    },
    appendEntry() {},
  };
  debloatExtension(pi as never);
  if (!handler) throw new Error("debloat did not register a context handler");
  return handler;
}

/** `ctx` backed by a real `SessionManager` (no UI). */
function makeCtx(sm: SessionManager): unknown {
  return {
    hasUI: false,
    ui: {
      notify() {},
      setStatus() {},
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
    },
    sessionManager: {
      getBranch: () => sm.getBranch(),
      buildContextEntries: () => sm.buildContextEntries(),
      getLeafId: () => sm.getLeafId(),
    },
  };
}

/** Run the extension's `context` handler with pi's real message list. */
function runContextHandler(sm: SessionManager): { messages: MessageLike[] } | undefined {
  const messages = sm.buildSessionContext().messages as unknown as MessageLike[];
  return installContextHandler()({ messages }, makeCtx(sm));
}

describe("pi integration: Debloat's index map vs pi's real projection", () => {
  it("(a) plain user/assistant/toolResult turns: aligned, nothing to compact", () => {
    const sm = tempSession();
    sm.appendMessage(user("u1", 1));
    sm.appendMessage(assistantToolCall("tc1", 2));
    sm.appendMessage(toolResult("tc1", 3));
    sm.appendMessage(user("u2", 4));
    sm.appendMessage(assistantText("a2", 5));

    const a = debloatInputs(sm);
    // pi's three projections agree: 5 message entries -> 5 messages.
    expect(a.projected.map((m) => m.role)).toEqual(a.viaStandalone.map((m) => m.role));
    expect(a.contextMessages.length).toBe(5);
    // Debloat's map covers exactly one slot per projected message.
    expect(a.indexMap.length).toBe(a.contextMessages.length);
    expect(a.indexMap).toEqual(a.entries.map((e) => e.id));

    expect(a.state.compactions).toHaveLength(0);
    const rebuilt = rebuild(sm);
    // Aligned => rebuildMessages never fails open; nothing to apply is applied 0.
    expect(rebuilt.result).not.toBeNull();
    expect(rebuilt.result!.applied).toBe(0);
    expect(runContextHandler(sm)).toBeUndefined();
  });

  it("(b) checkpoints + one compaction span: aligned and the span is actually applied", () => {
    const sm = tempSession();
    const u1 = sm.appendMessage(user("u1", 1));
    const a1 = sm.appendMessage(assistantText("a1", 2));
    sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { afterEntryId: a1, label: "one" });
    const u2 = sm.appendMessage(user("u2", 3));
    const a2 = sm.appendMessage(assistantText("a2", 4));
    sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { afterEntryId: a2, label: "two" });
    const u3 = sm.appendMessage(user("u3", 5));
    const a3 = sm.appendMessage(assistantText("a3", 6));
    sm.appendCustomEntry(COMPACTION_CUSTOM_TYPE, {
      fromAfterEntryId: a1,
      toAfterEntryId: a2,
      title: "one-to-two",
      summary: "the turn between checkpoint one and two",
    });
    void u1;
    void u2;
    void u3;

    const a = debloatInputs(sm);
    expect(a.state.activeCheckpoints.map((c) => c.label)).toEqual(["one", "two"]);
    expect(a.state.compactions).toHaveLength(1);
    // 6 message entries; the 3 custom entries project to nothing.
    expect(a.contextMessages.length).toBe(6);
    expect(a.indexMap.length).toBe(a.contextMessages.length);

    const rebuilt = rebuild(sm);
    expect(rebuilt.result).not.toBeNull();
    expect(rebuilt.result!.applied).toBe(1);
    // Span is (a1, a2]: u2 + a2 collapse into one summary; a1 and the newest turn
    // stay raw and in order (projected = [u1, a1, u2, a2, u3, a3]).
    const out = rebuilt.result!.messages;
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(a.projected[0]);
    expect(out[1]).toBe(a.projected[1]);
    expect(out[2]!.role).toBe("user");
    expect(String(out[2]!.content)).toBe(
      "[Debloat summary " + a1 + "→" + a2 + ": one-to-two]\n\nthe turn between checkpoint one and two",
    );
    expect(out[3]).toBe(a.projected[4]);
    expect(out[4]).toBe(a.projected[5]);
  });

  it("(c) native compaction + stale checkpoint: aligned, stale span skipped, raw kept", () => {
    const sm = tempSession();
    const u1 = sm.appendMessage(user("u1", 1));
    const a1 = sm.appendMessage(assistantText("a1", 2));
    sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { afterEntryId: u1, label: "stale-one" });
    const u2 = sm.appendMessage(user("u2", 3));
    const a2 = sm.appendMessage(assistantText("a2", 4));
    // pi's native compaction: everything before u2 is replaced by a summary.
    sm.appendCompaction("native summary", u2, 1234);
    const u3 = sm.appendMessage(user("u3", 5));
    const a3 = sm.appendMessage(assistantText("a3", 6));
    sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { afterEntryId: a3, label: "active-two" });
    // Debloat compaction over a span whose endpoints were dropped by the native cut.
    sm.appendCustomEntry(COMPACTION_CUSTOM_TYPE, {
      fromAfterEntryId: u1,
      toAfterEntryId: a2,
      title: "stale-span",
      summary: "must not apply",
    });

    const a = debloatInputs(sm);
    expect(a.state.nativeCutPointId).toBe(u2);
    expect(a.state.activeCheckpoints.map((c) => c.label)).toEqual(["active-two"]);
    // pi's context list: compaction summary + kept entries (u2, a2) + u3, a3.
    expect(a.contextMessages.map((m) => m.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(a.indexMap.length).toBe(a.contextMessages.length);
    // The dropped entries are not in the order, so the span is skipped, not applied.
    expect(a.indexMap).not.toContain(u1);
    expect(a.indexMap).not.toContain(a1);

    const rebuilt = rebuild(sm);
    expect(rebuilt.result).not.toBeNull();
    expect(rebuilt.result!.applied).toBe(0);
    // Nothing applied => handler keeps pi's raw list (fail-open no-op).
    expect(runContextHandler(sm)).toBeUndefined();
  });

  it("(d) interleaved custom (non-message) entries incl. debloat entries: aligned + applied", () => {
    const sm = tempSession();
    sm.appendMessage(user("u1", 1));
    const a1 = sm.appendMessage(assistantText("a1", 2));
    sm.appendCustomEntry("other-extension", { note: "state only" });
    sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { afterEntryId: a1, label: "one" });
    sm.appendMessage(user("u2", 3));
    const a2 = sm.appendMessage(assistantText("a2", 4));
    sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { afterEntryId: a2, label: "two" });
    sm.appendMessage(user("u3", 5));
    sm.appendMessage(assistantText("a3", 6));
    sm.appendCustomEntry(COMPACTION_CUSTOM_TYPE, {
      fromAfterEntryId: a1,
      toAfterEntryId: a2,
      title: "one-to-two",
      summary: "compacted",
    });

    const a = debloatInputs(sm);
    expect(a.contextMessages).toHaveLength(6);
    expect(a.indexMap.length).toBe(a.contextMessages.length);

    const rebuilt = rebuild(sm);
    expect(rebuilt.result!.applied).toBe(1);

    // End-to-end through the real extension handler.
    const result = runContextHandler(sm);
    expect(result).toBeDefined();
    // projected = [u1, a1, u2, a2, u3, a3] -> [u1, a1, summary, u3, a3].
    expect(result!.messages).toHaveLength(5);
    expect(result!.messages[0]).toBe(a.projected[0]);
    expect(result!.messages[1]).toBe(a.projected[1]);
    expect(String(result!.messages[2]!.content)).toBe(
      "[Debloat summary " + a1 + "→" + a2 + ": one-to-two]\n\ncompacted",
    );
    expect(result!.messages[3]).toBe(a.projected[4]);
    expect(result!.messages[4]).toBe(a.projected[5]);
  });

  it("(e) custom_message entry (extension-injected): aligned + applied", () => {
    const sm = tempSession();
    sm.appendMessage(user("u1", 1));
    const a1 = sm.appendMessage(assistantText("a1", 2));
    sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { afterEntryId: a1, label: "one" });
    sm.appendMessage(user("u2", 3));
    const a2 = sm.appendMessage(assistantText("a2", 4));
    sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { afterEntryId: a2, label: "two" });
    // Extension-injected custom message: pi projects it to one LLM message.
    sm.appendCustomMessageEntry("some-extension", "injected context", true);
    sm.appendMessage(user("u3", 5));
    sm.appendMessage(assistantText("a3", 6));
    sm.appendCustomEntry(COMPACTION_CUSTOM_TYPE, {
      fromAfterEntryId: a1,
      toAfterEntryId: a2,
      title: "one-to-two",
      summary: "compacted",
    });

    const a = debloatInputs(sm);
    expect(a.contextMessages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "custom",
      "user",
      "assistant",
    ]);
    expect(a.contextMessages).toHaveLength(7);
    // The custom_message entry is itself in the projection, so it needs a slot.
    expect(a.indexMap.length).toBe(a.contextMessages.length);

    const rebuilt = rebuild(sm);
    expect(rebuilt.result).not.toBeNull();
    expect(rebuilt.result!.applied).toBe(1);
    expect(rebuilt.result!.messages).toHaveLength(6);
    expect(rebuilt.result!.messages[3]!.role).toBe("custom");

    const result = runContextHandler(sm);
    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(6);
    expect(String(result!.messages[2]!.content)).toContain("[Debloat summary ");
    expect(result!.messages[3]!.role).toBe("custom");
  });

  it("(e) branch_summary entry: aligned + applied", () => {
    const sm = tempSession();
    const u1 = sm.appendMessage(user("u1", 1));
    const a1 = sm.appendMessage(assistantText("a1", 2));
    const u2 = sm.appendMessage(user("u2", 3));
    sm.appendMessage(assistantText("a2", 4));
    // Fork back to u2 with a summary of the abandoned path.
    sm.branchWithSummary(u2, "the abandoned branch talked about a2", undefined, false);
    const u3 = sm.appendMessage(user("u3", 5));
    const a3 = sm.appendMessage(assistantText("a3", 6));
    sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { afterEntryId: a1, label: "one" });
    sm.appendCustomEntry(CHECKPOINT_CUSTOM_TYPE, { afterEntryId: a3, label: "two" });
    sm.appendCustomEntry(COMPACTION_CUSTOM_TYPE, {
      fromAfterEntryId: a1,
      toAfterEntryId: a3,
      title: "one-to-two",
      summary: "compacted",
    });
    void u1;

    const a = debloatInputs(sm);
    expect(a.contextMessages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "branchSummary",
      "user",
      "assistant",
    ]);
    expect(a.indexMap.length).toBe(a.contextMessages.length);

    const rebuilt = rebuild(sm);
    expect(rebuilt.result).not.toBeNull();
    expect(rebuilt.result!.applied).toBe(1);
    // Span (a1, a3]: u2 + branchSummary + u3 + a3 -> one summary.
    expect(rebuilt.result!.messages).toHaveLength(3);
    expect(String(rebuilt.result!.messages[2]!.content)).toContain("[Debloat summary ");

    const result = runContextHandler(sm);
    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(3);
  });
});
