/**
 * Pure context assembly: drop messages inside compacted spans and inject one
 * synthetic summary message per applied span.
 *
 * No runtime pi/fs/os imports: fully unit-testable. Raw session data is never
 * mutated; the caller keeps pi's original list when anything looks off.
 */

import type { DebloatState, MessageLike } from "./state.js";

export const DEBLOAT_PREFIX = "[Debloat summary ";

/** A message paired with the session entry id it came from (`null` when unknown). */
export interface IndexedMessage {
  entryId: string | null;
  message: MessageLike;
}

/** `[Debloat summary <from>→<to>: <title>]\n\n<summary>` (literal arrow). */
export function formatSummaryContent(
  fromAfterEntryId: string,
  toAfterEntryId: string,
  title: string,
  summary: string,
): string {
  return `${DEBLOAT_PREFIX}${fromAfterEntryId}→${toAfterEntryId}: ${title}]\n\n${summary}`;
}

function buildOrder(entryOrder: readonly string[]): Map<string, number> {
  const order = new Map<string, number>();
  for (let i = 0; i < entryOrder.length; i++) {
    const id = entryOrder[i];
    if (typeof id === "string" && id.length > 0 && !order.has(id)) order.set(id, i);
  }
  return order;
}

interface AppliedCompaction {
  start: number;
  entryId: string;
  message: MessageLike;
}

/**
 * Span membership: `index(entryId) > index(from) && index(entryId) <= index(to)`
 * over `entryOrder`. Compactions with missing endpoints or an empty span are
 * skipped, not counted.
 */
function applyInternal(
  items: readonly IndexedMessage[],
  state: DebloatState,
  entryOrder: readonly string[],
): { items: IndexedMessage[]; applied: number } {
  const order = buildOrder(entryOrder);
  const dropped = new Set<number>();
  const applied: AppliedCompaction[] = [];

  for (const compaction of state.compactions) {
    const from = order.get(compaction.fromAfterEntryId);
    const to = order.get(compaction.toAfterEntryId);
    if (from === undefined || to === undefined) continue;

    const members: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const entryId = items[i]!.entryId;
      if (entryId === null) continue;
      const position = order.get(entryId);
      if (position === undefined) continue;
      if (position > from && position <= to) members.push(i);
    }
    if (members.length === 0) continue;

    for (const member of members) dropped.add(member);
    applied.push({
      start: members[0]!,
      // The synthetic message carries the span's `to` entry id so callers can
      // align the rebuilt list back to `entryOrder`.
      entryId: compaction.toAfterEntryId,
      message: {
        role: "user",
        content: formatSummaryContent(
          compaction.fromAfterEntryId,
          compaction.toAfterEntryId,
          compaction.title,
          compaction.summary,
        ),
        timestamp: Date.now(),
      },
    });
  }

  const atStart = new Map<number, AppliedCompaction[]>();
  for (const entry of applied) {
    const list = atStart.get(entry.start);
    if (list) list.push(entry);
    else atStart.set(entry.start, [entry]);
  }

  const out: IndexedMessage[] = [];
  for (let i = 0; i <= items.length; i++) {
    const injections = atStart.get(i);
    if (injections) {
      for (const entry of injections) out.push({ entryId: entry.entryId, message: entry.message });
    }
    if (i === items.length) break;
    if (dropped.has(i)) continue;
    out.push(items[i]!);
  }

  return { items: out, applied: applied.length };
}

/** Drop compacted messages and inject one summary per applied span. */
export function applyCompactions(
  items: readonly IndexedMessage[],
  state: DebloatState,
  entryOrder: readonly string[],
): IndexedMessage[] {
  return applyInternal(items, state, entryOrder).items;
}

/**
 * Zip messages with their entry ids and apply compactions. Returns `null` when
 * `indexMap` disagrees with the real message list (caller then keeps pi's list).
 */
export function rebuildMessages(
  messages: readonly MessageLike[],
  indexMap: readonly (string | null)[],
  state: DebloatState,
  entryOrder: readonly string[],
): { messages: MessageLike[]; applied: number } | null {
  if (indexMap.length !== messages.length) return null;
  const items: IndexedMessage[] = messages.map((message, i) => ({
    entryId: indexMap[i] ?? null,
    message,
  }));
  const rebuilt = applyInternal(items, state, entryOrder);
  return { messages: rebuilt.items.map((item) => item.message), applied: rebuilt.applied };
}
