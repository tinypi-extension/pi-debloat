/**
 * Pure derivation of Debloat state from a session's branch entries.
 *
 * No runtime pi/fs/os imports: this module must be unit-testable in plain vitest.
 * Entries are treated as read-only; malformed entries are skipped, never thrown.
 */

/** Minimal view of a pi message, pi-independent. */
export interface MessageLike {
  role: string;
  content?: unknown;
  usage?: { totalTokens?: number; output?: number; [k: string]: unknown };
  timestamp?: number;
  [k: string]: unknown;
}

/** Minimal view of a pi session entry, pi-independent. */
export interface EntryLike {
  id: string;
  parentId?: string | null;
  type: string;
  customType?: string;
  data?: unknown;
  message?: MessageLike;
  firstKeptEntryId?: string;
  summary?: string;
  [k: string]: unknown;
}

export const CHECKPOINT_CUSTOM_TYPE = "debloat-checkpoint";
export const COMPACTION_CUSTOM_TYPE = "debloat-compaction";
export const TOMBSTONE_CUSTOM_TYPE = "debloat-tombstone";

export interface Checkpoint {
  entryId: string;
  afterEntryId: string;
  label: string;
  stale: boolean;
}

export interface Compaction {
  entryId: string;
  fromAfterEntryId: string;
  toAfterEntryId: string;
  title: string;
  summary: string;
  usage?: unknown;
}

export interface DebloatState {
  /** ALL non-ignored checkpoints, logical (branch) order, oldest -> newest. */
  checkpoints: Checkpoint[];
  /** Checkpoints with `stale === false`. */
  activeCheckpoints: Checkpoint[];
  /** Accepted compactions, logical order, oldest -> newest. */
  compactions: Compaction[];
  /** Number of checkpoints ignored by tombstones. */
  removedCheckpointCount: number;
  hasTombstone: boolean;
  /** `firstKeptEntryId` of the latest native compaction, else null. */
  nativeCutPointId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function indexOfId(entries: readonly EntryLike[], id: string): number {
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]?.id === id) return i;
  }
  return -1;
}

/**
 * Two spans overlap when their covered message sets intersect. A span covers
 * `(fromAfterEntryId, toAfterEntryId]` (exclusive of `from`, inclusive of `to`),
 * so adjacent spans sharing an endpoint are NOT overlapping.
 */
function overlapsAccepted(
  accepted: readonly Compaction[],
  next: Compaction,
  entries: readonly EntryLike[],
): boolean {
  const nextFrom = indexOfId(entries, next.fromAfterEntryId);
  const nextTo = indexOfId(entries, next.toAfterEntryId);
  if (nextFrom < 0 || nextTo < 0) return false;
  for (const existing of accepted) {
    if (
      existing.fromAfterEntryId === next.fromAfterEntryId &&
      existing.toAfterEntryId === next.toAfterEntryId
    ) {
      return true;
    }
    const from = indexOfId(entries, existing.fromAfterEntryId);
    const to = indexOfId(entries, existing.toAfterEntryId);
    if (from < 0 || to < 0) continue;
    if (nextFrom < to && from < nextTo) return true;
  }
  return false;
}

/**
 * Derive checkpoints, compactions and staleness from a plain entry array.
 *
 * - Processing order is array order; a tombstone ignores every checkpoint already
 *   processed (i.e. earlier in the array).
 * - Returned checkpoints/compactions are re-ordered by their logical position so
 *   callers can rely on oldest -> newest.
 * - `nativeCutPointId` wins when supplied; otherwise it is read from the latest
 *   native `compaction` entry's `firstKeptEntryId`.
 */
export function deriveState(
  entries: readonly EntryLike[],
  nativeCutPointId?: string | null,
): DebloatState {
  const checkpoints: Checkpoint[] = [];
  const compactions: Compaction[] = [];
  let removedCheckpointCount = 0;
  let hasTombstone = false;

  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom") continue;

    if (entry.customType === CHECKPOINT_CUSTOM_TYPE) {
      const data = entry.data;
      if (!isRecord(data)) continue;
      if (
        !nonEmptyString(entry.id) ||
        !nonEmptyString(data.afterEntryId) ||
        !nonEmptyString(data.label)
      ) {
        continue;
      }
      checkpoints.push({
        entryId: entry.id,
        afterEntryId: data.afterEntryId,
        label: data.label,
        stale: false,
      });
    } else if (entry.customType === COMPACTION_CUSTOM_TYPE) {
      const data = entry.data;
      if (!isRecord(data)) continue;
      if (
        !nonEmptyString(entry.id) ||
        !nonEmptyString(data.fromAfterEntryId) ||
        !nonEmptyString(data.toAfterEntryId) ||
        !nonEmptyString(data.title) ||
        !nonEmptyString(data.summary)
      ) {
        continue;
      }
      const next: Compaction = {
        entryId: entry.id,
        fromAfterEntryId: data.fromAfterEntryId,
        toAfterEntryId: data.toAfterEntryId,
        title: data.title,
        summary: data.summary,
      };
      if ("usage" in data) next.usage = data.usage;
      if (overlapsAccepted(compactions, next, entries)) continue;
      compactions.push(next);
    } else if (entry.customType === TOMBSTONE_CUSTOM_TYPE) {
      // A tombstone's `data` is informational; its effect does not depend on it.
      hasTombstone = true;
      removedCheckpointCount += checkpoints.length;
      checkpoints.length = 0;
    }
  }

  const positions = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const id = entries[i]?.id;
    if (nonEmptyString(id) && !positions.has(id)) positions.set(id, i);
  }

  const logicalPos = (id: string): number => positions.get(id) ?? Number.POSITIVE_INFINITY;
  checkpoints.sort((a, b) => logicalPos(a.afterEntryId) - logicalPos(b.afterEntryId));
  compactions.sort(
    (a, b) =>
      logicalPos(a.fromAfterEntryId) - logicalPos(b.fromAfterEntryId) ||
      logicalPos(a.toAfterEntryId) - logicalPos(b.toAfterEntryId),
  );

  let cutPoint: string | null = nonEmptyString(nativeCutPointId) ? nativeCutPointId : null;
  if (cutPoint === null) {
    for (const entry of entries) {
      if (isRecord(entry) && entry.type === "compaction" && nonEmptyString(entry.firstKeptEntryId)) {
        cutPoint = entry.firstKeptEntryId;
      }
    }
  }

  const cutPos = cutPoint !== null ? positions.get(cutPoint) : undefined;
  for (const checkpoint of checkpoints) {
    const afterPos = positions.get(checkpoint.afterEntryId);
    // Missing anchor => stale; unknown cut point => cannot prove staleness.
    checkpoint.stale =
      afterPos === undefined ? true : cutPos !== undefined && afterPos < cutPos;
  }

  return {
    checkpoints,
    activeCheckpoints: checkpoints.filter((checkpoint) => !checkpoint.stale),
    compactions,
    removedCheckpointCount,
    hasTombstone,
    nativeCutPointId: cutPoint,
  };
}
