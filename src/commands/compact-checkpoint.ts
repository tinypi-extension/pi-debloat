/**
 * `/compact-checkpoint` — compact every uncompacted checkpoint-to-checkpoint
 * span sequentially, one one-shot call per span. The newest span stays raw.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { createCaller, currentLeafId, errorText } from "../pi-glue.js";
import {
  COMPACT_MAX_CHARS_PER_ENTRY,
  formatTranscript,
  readSkillFile,
  requestJson,
  validateCompact,
} from "../llm.js";
import { computeSpans, isMessageEntry, type Span } from "../ranges.js";
import { loadSettings, resolveSettings } from "../settings.js";
import {
  COMPACTION_CUSTOM_TYPE,
  deriveState,
  type Compaction,
  type EntryLike,
} from "../state.js";

const SKILL_FILE = "compact.md";

/** Message entries strictly after `fromAfterEntryId` up to and including `toAfterEntryId`. */
function spanEntries(
  entries: readonly EntryLike[],
  fromAfterEntryId: string,
  toAfterEntryId: string,
): EntryLike[] {
  const from = entries.findIndex((entry) => entry.id === fromAfterEntryId);
  const to = entries.findIndex((entry) => entry.id === toAfterEntryId);
  if (from < 0 || to < 0 || to <= from) return [];
  const out: EntryLike[] = [];
  for (let i = from + 1; i <= to; i++) {
    const entry = entries[i];
    if (entry && isMessageEntry(entry)) out.push(entry);
  }
  return out;
}

function spanPreamble(span: Span, earlierTitles: readonly string[]): string {
  const earlier =
    earlierTitles.length === 0
      ? "(none)"
      : earlierTitles.map((title) => `"${title}"`).join(", ");
  return [
    `span: from checkpoint "${span.fromLabel}" to checkpoint "${span.toLabel}"`,
    `earlier summaries (titles only): ${earlier}`,
  ].join("\n");
}

/** Entry-id -> position, used to order compactions by span position. */
function positionsOf(entries: readonly EntryLike[]): Map<string, number> {
  const positions = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const id = entries[i]?.id;
    if (typeof id === "string" && id.length > 0 && !positions.has(id)) positions.set(id, i);
  }
  return positions;
}

/** Titles of accepted compactions whose span begins before `span` does. */
function earlierTitlesFor(
  compactions: readonly Compaction[],
  positions: ReadonlyMap<string, number>,
  span: Span,
): string[] {
  const spanFrom = positions.get(span.fromAfterEntryId);
  if (spanFrom === undefined) return [];
  return compactions
    .filter((compaction) => {
      const from = positions.get(compaction.fromAfterEntryId);
      return from !== undefined && from < spanFrom;
    })
    .map((compaction) => compaction.title);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Summed token/cost usage across the calls actually made this run. */
interface UsageTotals {
  input?: number;
  output?: number;
  total?: number;
  cost?: number;
  calls: number;
}

/** `usage` is `unknown`; read the pi-ai shape defensively and ignore anything else. */
function addUsage(totals: UsageTotals, usage: unknown): void {
  if (typeof usage !== "object" || usage === null) return;
  const record = usage as Record<string, unknown>;
  const input = numberOf(record.input) ?? numberOf(record.promptTokens);
  const output = numberOf(record.output) ?? numberOf(record.completionTokens);
  const total =
    numberOf(record.totalTokens) ??
    (input !== undefined && output !== undefined ? input + output : undefined);
  const costRecord =
    typeof record.cost === "object" && record.cost !== null
      ? (record.cost as Record<string, unknown>)
      : undefined;
  const cost = numberOf(record.cost) ?? (costRecord ? numberOf(costRecord.total) : undefined);

  if (input !== undefined) totals.input = (totals.input ?? 0) + input;
  if (output !== undefined) totals.output = (totals.output ?? 0) + output;
  if (total !== undefined) totals.total = (totals.total ?? 0) + total;
  if (cost !== undefined) totals.cost = (totals.cost ?? 0) + cost;
  totals.calls += 1;
}

function usageTotalsText(totals: UsageTotals): string {
  if (totals.calls === 0) return "";
  const parts: string[] = [];
  if (totals.input !== undefined || totals.output !== undefined || totals.total !== undefined) {
    parts.push(
      `tokens ${totals.input ?? "?"} in / ${totals.output ?? "?"} out / ${totals.total ?? "?"} total`,
    );
  }
  if (totals.cost !== undefined) parts.push(`cost $${totals.cost}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export async function runCompactCheckpoint(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  void args;
  try {
    const entries = ctx.sessionManager.getBranch() as unknown as EntryLike[];
    const state = deriveState(entries);
    if (state.activeCheckpoints.length === 0) {
      ctx.ui.notify("Debloat: no checkpoints — run /checkpoint-make first.", "info");
      return;
    }

    const leafId = currentLeafId(ctx) ?? "";
    const { compactable } = computeSpans(state, leafId);
    if (compactable.length === 0) {
      ctx.ui.notify(
        "Debloat: nothing to compact — the newest span stays raw.",
        "info",
      );
      return;
    }

    const settings = resolveSettings(loadSettings());
    if (!settings.compactModel) {
      ctx.ui.notify(
        "Debloat: no compact model configured — run /debloat settings.",
        "error",
      );
      return;
    }

    const systemPrompt = readSkillFile(SKILL_FILE);
    if (systemPrompt.length === 0) {
      ctx.ui.notify(
        `Debloat: prompt file ${SKILL_FILE} could not be read — reinstall the extension.`,
        "error",
      );
      return;
    }

    const caller = createCaller(ctx, settings.compactModel, settings.compactThinkingLevel);
    const positions = positionsOf(entries);
    const newTitles: string[] = [];
    const totals: UsageTotals = { calls: 0 };
    let compactedCount = 0;

    for (let i = 0; i < compactable.length; i++) {
      const span = compactable[i]!;
      ctx.ui.setStatus("debloat", `compacting ${i + 1}/${compactable.length} …`);

      const earlierTitles = [
        ...earlierTitlesFor(state.compactions, positions, span),
        ...newTitles,
      ];
      const members = spanEntries(entries, span.fromAfterEntryId, span.toAfterEntryId);
      const userPrompt = [
        spanPreamble(span, earlierTitles),
        "",
        // The compactor needs full fidelity (commands, paths), so it gets the wide budget.
        formatTranscript(members, { maxCharsPerEntry: COMPACT_MAX_CHARS_PER_ENTRY }),
      ].join(
        "\n",
      );

      const result = await requestJson(
        caller.call,
        { systemPrompt, userPrompt, thinkingLevel: settings.compactThinkingLevel },
        validateCompact,
      );
      if (!result.ok) {
        ctx.ui.setStatus("debloat", undefined);
        ctx.ui.notify(
          `Debloat: compacting span "${span.fromLabel}" → "${span.toLabel}" failed — ${result.error}. Earlier spans were kept.`,
          "error",
        );
        return;
      }

      pi.appendEntry(COMPACTION_CUSTOM_TYPE, {
        fromAfterEntryId: span.fromAfterEntryId,
        toAfterEntryId: span.toAfterEntryId,
        title: result.value.title,
        summary: result.value.summary,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });

      // Safety net: `state` rejects a span that overlaps an accepted compaction,
      // so confirm from the branch that this one was actually kept.
      const accepted = deriveState(
        ctx.sessionManager.getBranch() as unknown as EntryLike[],
      ).compactions.some(
        (compaction) =>
          compaction.fromAfterEntryId === span.fromAfterEntryId &&
          compaction.toAfterEntryId === span.toAfterEntryId,
      );
      if (!accepted) {
        ctx.ui.notify(
          `Debloat: span "${span.fromLabel}" → "${span.toLabel}" was not applied (it overlaps an existing summary); skipped.`,
          "warning",
        );
        continue;
      }

      compactedCount += 1;
      newTitles.push(result.value.title);
      addUsage(totals, result.usage);
    }

    ctx.ui.setStatus("debloat", undefined);
    const rejected = compactable.length - compactedCount;
    if (compactedCount === 0) {
      ctx.ui.notify(
        `Debloat: compacted 0 span(s); ${rejected} rejected as overlapping. The newest span is left raw.`,
        "info",
      );
      return;
    }
    ctx.ui.notify(
      `Debloat: compacted ${compactedCount} span(s)${
        rejected > 0 ? `, ${rejected} rejected as overlapping` : ""
      }; the newest span is left raw.${usageTotalsText(totals)}`,
      "info",
    );
  } catch (error) {
    ctx.ui.setStatus("debloat", undefined);
    ctx.ui.notify(`Debloat: ${errorText(error)}`, "error");
  }
}
