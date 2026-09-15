/**
 * Debloat extension entry point.
 *
 * Registers the user commands and the `context`/`session_start` handlers. Every
 * handler is fail-open: a mismatch or exception returns `undefined` so pi keeps
 * its native behavior.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { runCheckpointMake } from "./commands/checkpoint-make.js";
import { runCompactCheckpoint } from "./commands/compact-checkpoint.js";
import { debloatArgumentCompletions, runDebloat } from "./commands/debloat.js";
import { rebuildMessages } from "./context-build.js";
import { readState } from "./pi-glue.js";
import { messageIndexMap } from "./ranges.js";
import { deriveState, type EntryLike, type MessageLike } from "./state.js";

/** Status shown when the context list cannot be reconciled with the branch. */
const ALIGNMENT_FAILED_STATUS = "debloat: context alignment failed";

function entriesOf(ctx: ExtensionContext): EntryLike[] {
  return ctx.sessionManager.getBranch() as unknown as EntryLike[];
}

/** Active entry order for the LLM view, falling back to the raw branch. */
function contextEntriesOf(ctx: ExtensionContext, branch: readonly EntryLike[]): EntryLike[] {
  try {
    const built = ctx.sessionManager.buildContextEntries() as unknown as
      | EntryLike[]
      | null
      | undefined;
    if (Array.isArray(built)) return built;
  } catch {
    // fall through to the raw branch
  }
  return [...branch];
}

function statusText(ctx: ExtensionContext): string | undefined {
  const state = readState(ctx);
  if (state.checkpoints.length === 0 && state.compactions.length === 0) return undefined;
  return `${state.checkpoints.length} checkpoints / ${state.compactions.length} spans`;
}

/** pi's own entry -> message projection, when the running pi exposes it. */
type ProjectEntry = (entry: SessionEntry) => AgentMessage[];

const projectEntry: ProjectEntry | undefined = (() => {
  const candidate = (piCodingAgent as { sessionEntryToContextMessages?: unknown })
    .sessionEntryToContextMessages;
  return typeof candidate === "function" ? (candidate as ProjectEntry) : undefined;
})();

/** One projected LLM message plus the session entry it came from. */
interface ProjectedItem {
  entryId: string | null;
  message: MessageLike;
}

/**
 * pi's projection of every active entry, one item per LLM-visible message.
 * Returns `null` when pi's projection is unavailable or throws, so the handler
 * can fall back to the pure `messageIndexMap`.
 */
function projectionItems(entries: readonly EntryLike[]): ProjectedItem[] | null {
  if (!projectEntry) return null;
  try {
    const items: ProjectedItem[] = [];
    for (const entry of entries) {
      const projected = projectEntry(entry as unknown as SessionEntry);
      if (!Array.isArray(projected)) return null;
      const entryId = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null;
      for (const message of projected) {
        items.push({ entryId, message: message as unknown as MessageLike });
      }
    }
    return items;
  } catch {
    return null;
  }
}

const FINGERPRINT_CAP = 512;

/** Cheap content fingerprint used to match a projection slot to a real message. */
function fingerprint(message: MessageLike | undefined): string {
  if (!message || typeof message !== "object") return "";
  const role = typeof message.role === "string" ? message.role : "";
  let body = "";
  try {
    body = JSON.stringify(message.content) ?? "";
  } catch {
    body = "";
  }
  if (body.length > FINGERPRINT_CAP) body = body.slice(0, FINGERPRINT_CAP);
  return `${role}\u0000${body}`;
}

interface Alignment {
  indexMap: (string | null)[];
  skipped: number;
}

/**
 * Align pi's projection with the messages pi actually sends. Usually the lengths
 * match; after a retryable provider error pi trims `agent.state.messages` while
 * keeping the entry on the branch, so the projection has extra trailing slots.
 * Walk from the END and skip projected slots that match no event message; a slot
 * that cannot be matched means the list is genuinely unreconcilable (`null`).
 */
function alignProjection(
  items: readonly ProjectedItem[],
  messages: readonly MessageLike[],
): Alignment | null {
  if (items.length === messages.length) {
    return { indexMap: items.map((item) => item.entryId), skipped: 0 };
  }

  const indexMap: (string | null)[] = new Array(messages.length).fill(null);
  let i = messages.length - 1;
  let j = items.length - 1;
  let skipped = 0;
  while (i >= 0 && j >= 0) {
    if (fingerprint(items[j]!.message) === fingerprint(messages[i])) {
      indexMap[i] = items[j]!.entryId;
      i -= 1;
      j -= 1;
    } else {
      // pi dropped this projected message from agent state; skip its slot.
      j -= 1;
      skipped += 1;
    }
  }
  if (i >= 0) return null;
  return { indexMap, skipped };
}

/** hasUI-guarded status update that never throws into pi's handler. */
function setStatus(ctx: ExtensionContext, text: string | undefined): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.setStatus("debloat", text);
  } catch {
    // a status line is never worth failing a context transform
  }
}

export default function debloatExtension(pi: ExtensionAPI): void {
  // Re-alignment notification is emitted at most once per session.
  let realignNotified = false;

  pi.registerCommand("checkpoint-make", {
    description: "Place labeled checkpoints on the current branch via a sub-model",
    handler: (args, ctx) => runCheckpointMake(pi, args, ctx),
  });

  pi.registerCommand("compact-checkpoint", {
    description: "Summarize each checkpoint-to-checkpoint span; newest span stays raw",
    handler: (args, ctx) => runCompactCheckpoint(pi, args, ctx),
  });

  pi.registerCommand("debloat", {
    description: "Debloat settings, timeline and checkpoint removal",
    getArgumentCompletions: debloatArgumentCompletions,
    handler: (args, ctx) => runDebloat(pi, args, ctx),
  });

  // Fail-open: never mutate `event.messages`; return a rebuilt list only when
  // every compaction applied cleanly to a reconciled message list.
  pi.on("context", (event, ctx) => {
    try {
      const branch = entriesOf(ctx);
      const state = deriveState(branch);
      const contextEntries = contextEntriesOf(ctx, branch);
      const entryOrder = contextEntries.map((entry) => entry.id);
      const messages = event.messages as unknown as MessageLike[];

      let indexMap: (string | null)[];
      let skipped = 0;
      const items = projectionItems(contextEntries);
      if (items) {
        const aligned = alignProjection(items, messages);
        if (!aligned) {
          // Genuinely unreconcilable: fail open, but make it visible.
          if (state.compactions.length > 0) setStatus(ctx, ALIGNMENT_FAILED_STATUS);
          return undefined;
        }
        indexMap = aligned.indexMap;
        skipped = aligned.skipped;
      } else {
        indexMap = messageIndexMap(contextEntries);
      }

      const result = rebuildMessages(messages, indexMap, state, entryOrder);
      if (!result) {
        if (state.compactions.length > 0) setStatus(ctx, ALIGNMENT_FAILED_STATUS);
        return undefined;
      }

      if (result.applied > 0) {
        if (skipped > 0 && !realignNotified) {
          realignNotified = true;
          if (ctx.hasUI) {
            try {
              ctx.ui.notify(
                "Debloat: re-aligned after pi trimmed context; summaries still applied",
                "warning",
              );
            } catch {
              // notify is best-effort
            }
          }
        }
        setStatus(ctx, `${result.applied} summary(s) applied`);
        return { messages: result.messages as unknown as AgentMessage[] };
      }

      // Nothing applied: never leave a stale "summaries applied" status behind.
      if (state.compactions.length > 0) setStatus(ctx, undefined);
      return undefined;
    } catch {
      return undefined;
    }
  });

  pi.on("session_start", (_event, ctx) => {
    realignNotified = false;
    try {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus("debloat", statusText(ctx));
    } catch {
      // fail-open: a status line is never worth failing a session start
    }
  });
}
