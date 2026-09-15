/**
 * Pure span/range math for Debloat: lookback-window capping, checkpoint-span
 * computation and cut-point validation.
 *
 * No runtime pi/fs/os imports: this module must be unit-testable in plain vitest.
 * Malformed input is skipped/short-circuited; nothing here throws.
 */

import type { DebloatState, EntryLike, MessageLike } from "./state.js";

export interface Span {
  fromAfterEntryId: string;
  toAfterEntryId: string;
  fromLabel: string | null;
  toLabel: string;
}

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function indexMap(entries: readonly EntryLike[]): Map<string, number> {
  const positions = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const id = entries[i]?.id;
    if (typeof id === "string" && id.length > 0 && !positions.has(id)) positions.set(id, i);
  }
  return positions;
}

/**
 * Two Debloat intervals `(from, to]` — exclusive of `from`, inclusive of `to` —
 * intersect. Spans sharing only an endpoint are NOT overlapping, mirroring
 * `state.ts`'s compaction-acceptance rule exactly.
 */
function intervalsIntersect(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom < bTo && bFrom < aTo;
}

/**
 * Best-effort logical positions for the ids Debloat's state knows about.
 *
 * `state.checkpoints` is ordered oldest -> newest by `afterEntryId`, and every
 * compaction endpoint originates from a checkpoint anchor (compactions are only
 * ever created for checkpoint-to-checkpoint spans), so this recovers the true
 * relative order of those ids without needing the raw entry array. Ids that
 * cannot be placed are absent from the map; callers fall back to an exact
 * endpoint comparison for those.
 */
function statePositions(state: DebloatState): Map<string, number> {
  const positions = new Map<string, number>();
  for (const checkpoint of state.checkpoints) {
    const id = checkpoint.afterEntryId;
    if (typeof id === "string" && id.length > 0 && !positions.has(id)) {
      positions.set(id, positions.size);
    }
  }
  return positions;
}

/** True when `(from, to]` intersects any accepted compaction interval. */
function isSpanCovered(
  state: DebloatState,
  positions: Map<string, number>,
  from: string,
  to: string,
): boolean {
  const fromPos = positions.get(from);
  const toPos = positions.get(to);
  for (const compaction of state.compactions) {
    if (compaction.fromAfterEntryId === from && compaction.toAfterEntryId === to) return true;
    if (fromPos === undefined || toPos === undefined) continue;
    const compactionFrom = positions.get(compaction.fromAfterEntryId);
    const compactionTo = positions.get(compaction.toAfterEntryId);
    if (compactionFrom === undefined || compactionTo === undefined) continue;
    if (intervalsIntersect(fromPos, toPos, compactionFrom, compactionTo)) return true;
  }
  return false;
}

/**
 * Checkpoint-to-checkpoint spans over the *active* checkpoints only.
 * The newest checkpoint -> current leaf span is always raw (never compactable).
 */
export function computeSpans(
  state: DebloatState,
  currentLeafId: string,
): { compactable: Span[]; newestRaw: Span | null } {
  const checkpoints = state.activeCheckpoints;
  if (checkpoints.length === 0) return { compactable: [], newestRaw: null };

  const positions = statePositions(state);
  const compactable: Span[] = [];
  for (let i = 0; i < checkpoints.length - 1; i++) {
    const from = checkpoints[i]!.afterEntryId;
    const to = checkpoints[i + 1]!.afterEntryId;
    if (isSpanCovered(state, positions, from, to)) continue;
    compactable.push({
      fromAfterEntryId: from,
      toAfterEntryId: to,
      fromLabel: checkpoints[i]!.label,
      toLabel: checkpoints[i + 1]!.label,
    });
  }

  const newest = checkpoints[checkpoints.length - 1]!;
  return {
    compactable,
    newestRaw: {
      fromAfterEntryId: newest.afterEntryId,
      toAfterEntryId: currentLeafId,
      fromLabel: newest.label,
      toLabel: "current",
    },
  };
}

/** True when cutting after `afterEntryId` would separate a tool call from its result. */
export function isToolPairSplit(entries: readonly EntryLike[], afterEntryId: string): boolean {
  const index = entries.findIndex((entry) => entry?.id === afterEntryId);
  if (index < 0) return true;
  const next = entries[index + 1];
  return next?.type === "message" && next.message?.role === "toolResult";
}

/** Drop boundaries that would be invalid, unreachable, stale or mid-tool-pair. */
export function sanitizeBoundaries(
  entries: readonly EntryLike[],
  state: DebloatState,
  currentLeafId: string,
  candidates: readonly { afterEntryId: string; label: string }[],
): { afterEntryId: string; label: string }[] {
  const positions = indexMap(entries);
  const leafPos = positions.get(currentLeafId) ?? Number.POSITIVE_INFINITY;
  const active = state.activeCheckpoints;
  const newestActive = active.length > 0 ? active[active.length - 1]!.afterEntryId : null;
  const newestActivePos = newestActive !== null ? positions.get(newestActive) : undefined;
  const cutPos =
    state.nativeCutPointId !== null ? positions.get(state.nativeCutPointId) : undefined;

  const seen = new Set<string>();
  const accepted: { afterEntryId: string; label: string }[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const id = candidate.afterEntryId;
    const label = candidate.label;
    if (typeof id !== "string" || typeof label !== "string") continue;
    const position = positions.get(id);
    if (position === undefined) continue;
    if (id === currentLeafId) continue;
    if (position >= leafPos) continue;
    if (cutPos !== undefined && position <= cutPos) continue;
    if (!KEBAB_CASE.test(label)) continue;
    if (newestActivePos !== undefined && position <= newestActivePos) continue;
    if (seen.has(id)) continue;
    if (isToolPairSplit(entries, id)) continue;
    seen.add(id);
    accepted.push({ afterEntryId: id, label });
  }
  return accepted;
}

/** `usage.totalTokens` when it is finite and positive, else ceil(chars / 4). */
export function estimateTokens(message: MessageLike | undefined): number {
  if (!message || typeof message !== "object") return 0;
  const totalTokens = message.usage?.totalTokens;
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
    return totalTokens;
  }
  let chars = 0;
  try {
    const serialized = JSON.stringify(message.content);
    if (typeof serialized === "string") chars = serialized.length;
  } catch {
    chars = 0;
  }
  return Math.ceil(chars / 4);
}

/**
 * Newest-first token-capped window over message entries.
 *
 * `startAfterEntryId` is the eligible window's exclusive anchor: the later of
 * the newest active checkpoint's `afterEntryId` and the native pi compaction
 * cut point, or null for session start. Messages pi no longer sends (at or
 * before the native cut) and messages inside an accepted compaction are never
 * included. The newest message is always kept even if it alone crosses the cap,
 * so the judge always sees the head.
 */
export function buildLookbackWindow(
  entries: readonly EntryLike[],
  state: DebloatState,
  maxTokens: number,
): { entries: EntryLike[]; startAfterEntryId: string | null; truncated: boolean; tokens: number } {
  const positions = indexMap(entries);
  const active = state.activeCheckpoints;

  let startPosition = -1;
  let startAfterEntryId: string | null = null;
  if (active.length > 0) {
    const anchor = active[active.length - 1]!.afterEntryId;
    const anchorPosition = positions.get(anchor);
    if (anchorPosition !== undefined) {
      startPosition = anchorPosition;
      startAfterEntryId = anchor;
    }
  }
  // Native compaction: messages at or before the cut are already absent from
  // pi's message list, so the judge must never scan them.
  if (state.nativeCutPointId !== null) {
    const cutPosition = positions.get(state.nativeCutPointId);
    if (cutPosition !== undefined && cutPosition > startPosition) {
      startPosition = cutPosition;
      startAfterEntryId = state.nativeCutPointId;
    }
  }

  // Accepted compactions: their covered messages are already summarized, so
  // re-exposing them to the judge would produce a redundant checkpoint.
  const coveredIntervals: { from: number; to: number }[] = [];
  for (const compaction of state.compactions) {
    const from = positions.get(compaction.fromAfterEntryId);
    const to = positions.get(compaction.toAfterEntryId);
    if (from !== undefined && to !== undefined) coveredIntervals.push({ from, to });
  }

  const eligible: EntryLike[] = [];
  for (let i = startPosition + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || !isMessageEntry(entry)) continue;
    // A message at index i lies in `(from, to]` iff `(i-1, i]` intersects it.
    const isCovered = coveredIntervals.some((interval) =>
      intervalsIntersect(interval.from, interval.to, i - 1, i),
    );
    if (!isCovered) eligible.push(entry);
  }

  const kept: EntryLike[] = [];
  let tokens = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const entry = eligible[i]!;
    tokens += estimateTokens(entry.message);
    kept.push(entry);
    if (tokens > maxTokens) break;
  }
  kept.reverse();

  return {
    entries: kept,
    startAfterEntryId,
    truncated: kept.length < eligible.length,
    tokens,
  };
}

/**
 * One slot per LLM-visible message, in order; the slot value is the source entry id
 * (or null for a contributing entry without a usable id). Non-message entries
 * (custom, label, model-change, thinking-level, session-info) produce no slot.
 */
export function messageIndexMap(entries: readonly EntryLike[]): (string | null)[] {
  const map: (string | null)[] = [];
  for (const entry of entries) {
    if (!entry || !contributesMessage(entry)) continue;
    map.push(typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null);
  }
  return map;
}

function contributesMessage(entry: EntryLike): boolean {
  if (entry.type === "message") return true;
  if (entry.type === "compaction") return true;
  // pi's real entry types are snake_case; the camelCase spellings are accepted
  // for legacy/hand-written entries. A `branch_summary` only projects when it
  // actually carries a summary (see sessionEntryToContextMessages).
  if (entry.type === "branch_summary" || entry.type === "branchSummary") {
    return typeof entry.summary === "string" && entry.summary.length > 0;
  }
  if (entry.type === "custom_message" || entry.type === "customMessage") return true;
  return entry.message?.role === "custom";
}

export function isMessageEntry(entry: EntryLike): boolean {
  return entry.type === "message" && entry.message !== undefined && entry.message !== null;
}
