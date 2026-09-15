/**
 * Integration smoke test for the extension entry point (SPEC success criterion 5).
 *
 * Uses a hand-rolled `pi`/`ctx` stub — no pi runtime, no model calls, no disk
 * writes — and asserts command registration plus the `context` fail-open rules.
 */

import { describe, expect, it } from "vitest";

import debloatExtension from "../src/index.js";
import type { EntryLike, MessageLike } from "../src/state.js";

interface RegisteredCommandStub {
  description?: string;
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: unknown) => unknown;
}

interface PiStub {
  commands: Map<string, RegisteredCommandStub>;
  events: Map<string, (event: unknown, ctx: unknown) => unknown>;
  appended: { customType: string; data: unknown }[];
}

type ContextHandler = (
  event: { messages: MessageLike[] },
  ctx: unknown,
) => { messages: MessageLike[] } | undefined | Promise<{ messages: MessageLike[] } | undefined>;

interface UiCalls {
  notifies: { msg: string; level?: string }[];
  statuses: { key: string; text: string | undefined }[];
}

function makePi(): PiStub {
  const stub: PiStub = {
    commands: new Map(),
    events: new Map(),
    appended: [],
  };
  return stub;
}

function install(stub: PiStub): void {
  const pi = {
    registerCommand(name: string, options: RegisteredCommandStub) {
      stub.commands.set(name, options);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      stub.events.set(event, handler);
    },
    appendEntry(customType: string, data: unknown) {
      stub.appended.push({ customType, data });
    },
  };
  debloatExtension(pi as never);
}

/** Branch: u1, a1, checkpoint(after a1), u2, a2, compaction covering a1. */
function fixture(): { branch: EntryLike[]; messages: MessageLike[] } {
  const branch: EntryLike[] = [
    { id: "e1", type: "message", message: { role: "user", content: "u1" } },
    { id: "e2", type: "message", message: { role: "assistant", content: "a1" } },
    {
      id: "e3",
      type: "custom",
      customType: "debloat-checkpoint",
      data: { afterEntryId: "e2", label: "turn-one-done" },
    },
    { id: "e4", type: "message", message: { role: "user", content: "u2" } },
    { id: "e5", type: "message", message: { role: "assistant", content: "a2" } },
    {
      id: "e6",
      type: "custom",
      customType: "debloat-compaction",
      data: {
        fromAfterEntryId: "e1",
        toAfterEntryId: "e2",
        title: "first-turn",
        summary: "the first turn happened",
      },
    },
  ];
  const messages: MessageLike[] = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
  ];
  return { branch, messages };
}

function makeCtx(
  branch: EntryLike[],
  opts?: { branchThrows?: boolean; hasUI?: boolean; calls?: UiCalls },
): unknown {
  const calls = opts?.calls;
  return {
    hasUI: opts?.hasUI ?? false,
    ui: {
      notify(msg: string, level?: string) {
        calls?.notifies.push({ msg, level });
      },
      setStatus(key: string, text: string | undefined) {
        calls?.statuses.push({ key, text });
      },
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
    },
    sessionManager: {
      getBranch() {
        if (opts?.branchThrows) throw new Error("no branch");
        return branch;
      },
      buildContextEntries() {
        return branch;
      },
      getLeafId() {
        return "e5";
      },
    },
  };
}

describe("debloat extension registration", () => {
  it("registers the three commands and both event handlers", () => {
    const stub = makePi();
    install(stub);

    expect([...stub.commands.keys()].sort()).toEqual([
      "checkpoint-make",
      "compact-checkpoint",
      "debloat",
    ]);
    expect(typeof stub.commands.get("debloat")?.getArgumentCompletions).toBe("function");
    expect([...stub.events.keys()].sort()).toEqual(["context", "session_start"]);
  });

  it("offers settings/timeline/remove-checkpoints argument completions", () => {
    const stub = makePi();
    install(stub);
    const completions = stub.commands.get("debloat")!.getArgumentCompletions!(
      "",
    ) as { value: string }[];
    expect(completions.map((item) => item.value)).toEqual([
      "settings",
      "timeline",
      "remove-checkpoints",
    ]);
  });

  it("does not append entries during registration or a context event", () => {
    const stub = makePi();
    install(stub);
    const { branch, messages } = fixture();
    stub.events.get("context")!({ messages }, makeCtx(branch));
    expect(stub.appended).toEqual([]);
  });
});

describe("context handler", () => {
  it("replaces the compacted raw message with one summary and keeps the newest raw", () => {
    const stub = makePi();
    install(stub);
    const { branch, messages } = fixture();

    const result = (stub.events.get("context") as ContextHandler)(
      { messages },
      makeCtx(branch),
    ) as { messages: MessageLike[] } | undefined;

    expect(result).toBeDefined();
    const out = result!.messages;
    expect(out.map((m) => m.content)).toEqual([
      "u1",
      "[Debloat summary e1→e2: first-turn]\n\nthe first turn happened",
      "u2",
      "a2",
    ]);
    expect(out).toHaveLength(4);
    expect(out[1]!.role).toBe("user");
    expect(String(out[1]!.content).startsWith("[Debloat summary ")).toBe(true);
    // Newest messages stay raw and order is preserved.
    expect(out[0]).toBe(messages[0]);
    expect(out[2]).toBe(messages[2]);
    expect(out[3]).toBe(messages[3]);
    // event.messages is untouched.
    expect(messages).toHaveLength(4);
    expect(messages[1]!.content).toBe("a1");
  });

  it("fails open (undefined) and never throws when the message list cannot be aligned", () => {
    const stub = makePi();
    install(stub);
    const { branch, messages } = fixture();
    // An extra message the branch never produced is genuinely unreconcilable.
    const unreconcilable = [...messages, { role: "user", content: "not in the branch" }];

    const handler = stub.events.get("context") as ContextHandler;
    const ctx = makeCtx(branch);
    expect(() => handler({ messages: unreconcilable }, ctx)).not.toThrow();
    expect(handler({ messages: unreconcilable }, makeCtx(branch))).toBeUndefined();
  });

  it("fails open (undefined) and never throws when getBranch() throws", () => {
    const stub = makePi();
    install(stub);
    const { branch, messages } = fixture();

    const handler = stub.events.get("context") as ContextHandler;
    expect(() => handler({ messages }, makeCtx(branch, { branchThrows: true }))).not.toThrow();
    expect(handler({ messages }, makeCtx(branch, { branchThrows: true }))).toBeUndefined();
  });

  it("returns undefined when there is nothing to compact", () => {
    const stub = makePi();
    install(stub);
    const messages: MessageLike[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];
    const branch: EntryLike[] = [
      { id: "e1", type: "message", message: messages[0] },
      { id: "e2", type: "message", message: messages[1] },
    ];

    const result = (stub.events.get("context") as ContextHandler)(
      { messages },
      makeCtx(branch),
    );

    expect(result).toBeUndefined();
  });

  // Fix A: after a retryable provider error pi trims `agent.state.messages`
  // (`messages.slice(0, -1)`) but keeps the entry on the branch, so the
  // projection has one more slot than the event. Debloat must re-align from the
  // end, still apply the summary, and warn at most once per session.
  it("re-aligns after pi trimmed the trailing message and still applies the summary", () => {
    const stub = makePi();
    install(stub);
    const { branch, messages } = fixture();
    const calls: UiCalls = { notifies: [], statuses: [] };
    const handler = stub.events.get("context") as ContextHandler;

    const result = handler(
      { messages: messages.slice(0, 3) },
      makeCtx(branch, { hasUI: true, calls }),
    ) as { messages: MessageLike[] } | undefined;

    expect(result).toBeDefined();
    expect(result!.messages.map((m) => m.content)).toEqual([
      "u1",
      "[Debloat summary e1→e2: first-turn]\n\nthe first turn happened",
      "u2",
    ]);
    expect(
      calls.notifies.filter((n) => n.msg.includes("re-aligned after pi trimmed")),
    ).toHaveLength(1);

    // A second transform in the same session must not notify again.
    handler({ messages: messages.slice(0, 3) }, makeCtx(branch, { hasUI: true, calls }));
    expect(
      calls.notifies.filter((n) => n.msg.includes("re-aligned after pi trimmed")),
    ).toHaveLength(1);
  });

  it("re-arms the re-alignment warning on session_start", () => {
    const stub = makePi();
    install(stub);
    const { branch, messages } = fixture();
    const calls: UiCalls = { notifies: [], statuses: [] };
    const handler = stub.events.get("context") as ContextHandler;

    handler({ messages: messages.slice(0, 3) }, makeCtx(branch, { hasUI: true, calls }));
    const sessionStart = stub.events.get("session_start") as (
      event: unknown,
      ctx: unknown,
    ) => unknown;
    sessionStart({}, makeCtx(branch, { hasUI: true, calls }));
    handler({ messages: messages.slice(0, 3) }, makeCtx(branch, { hasUI: true, calls }));

    expect(
      calls.notifies.filter((n) => n.msg.includes("re-aligned after pi trimmed")),
    ).toHaveLength(2);
  });

  // Fix H: an applied transform is inspectable via the status line, and an
  // unreconcilable transform is visible without any notify spam.
  it("reports applied summaries and alignment failures on the status line", () => {
    const stub = makePi();
    install(stub);
    const { branch, messages } = fixture();
    const handler = stub.events.get("context") as ContextHandler;

    const appliedCalls: UiCalls = { notifies: [], statuses: [] };
    const applied = handler({ messages }, makeCtx(branch, { hasUI: true, calls: appliedCalls }));
    expect(applied).toBeDefined();
    expect(appliedCalls.statuses).toContainEqual({ key: "debloat", text: "1 summary(s) applied" });

    const failedCalls: UiCalls = { notifies: [], statuses: [] };
    const unreconcilable = [...messages, { role: "user", content: "not in the branch" }];
    const failed = handler(
      { messages: unreconcilable },
      makeCtx(branch, { hasUI: true, calls: failedCalls }),
    );
    expect(failed).toBeUndefined();
    expect(failedCalls.statuses).toContainEqual({
      key: "debloat",
      text: "debloat: context alignment failed",
    });
  });
});
