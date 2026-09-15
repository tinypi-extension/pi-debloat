/**
 * `/debloat` — settings dialogs, timeline rendering and checkpoint removal.
 * The only command that writes settings; nothing here runs on its own.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { currentLeafId, errorText, readState } from "../pi-glue.js";
import { computeSpans } from "../ranges.js";
import { loadSettings, resolveSettings, saveSettings, type ModelRef } from "../settings.js";
import { TOMBSTONE_CUSTOM_TYPE, type DebloatState } from "../state.js";

export const DEBLOAT_SUBCOMMANDS = ["settings", "timeline", "remove-checkpoints"] as const;

export const DEBLOAT_USAGE = [
  "Debloat usage:",
  "  /debloat settings            — pick checkpoint/compact models, thinking levels, lookback budget",
  "  /debloat timeline            — list checkpoints, summaries and the raw span",
  "  /debloat remove-checkpoints  — ignore all current checkpoints (summaries stay in effect)",
].join("\n");

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const TOKEN_CHOICES = [25_000, 50_000, 100_000, 200_000] as const;
const CUSTOM_TOKENS = "custom…";

export function debloatArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const items: AutocompleteItem[] = [
    { value: "settings", label: "settings", description: "Configure models and lookback budget" },
    { value: "timeline", label: "timeline", description: "Show checkpoints and summaries" },
    {
      value: "remove-checkpoints",
      label: "remove-checkpoints",
      description: "Ignore all current checkpoints",
    },
  ];
  const filtered = items.filter((item) => item.value.startsWith(prefix));
  return filtered.length > 0 ? filtered : null;
}

function modelLabel(ref: ModelRef | undefined): string {
  return ref ? `${ref.provider}/${ref.modelId}` : "(unset)";
}

function keepCurrent(has: boolean): string {
  return has ? "<keep current>" : "<unset>";
}

function parseModelChoice(choice: string): ModelRef | undefined {
  const slash = choice.indexOf("/");
  if (slash <= 0 || slash === choice.length - 1) return undefined;
  return { provider: choice.slice(0, slash), modelId: choice.slice(slash + 1) };
}

function parseTokenChoice(choice: string): number | undefined {
  const digits = choice.replace(/[^0-9]/g, "");
  if (digits.length === 0) return undefined;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The file `saveSettings` will write to when no layer is forced (project layer
 * only when `<cwd>/.pi/` already exists, else global). Mirrors its resolution so
 * the notify can name the file that was actually written.
 */
function defaultSettingsFile(): string {
  const cwd = process.cwd();
  const home = os.homedir();
  let project = false;
  try {
    project = fs.statSync(path.join(cwd, ".pi")).isDirectory();
  } catch {
    project = false;
  }
  return project
    ? path.join(cwd, ".pi", "debloat.json")
    : path.join(home, ".pi", "agent", "debloat.json");
}

/** Sequential settings dialogs; cancelling any dialog aborts without writes. */
async function runSettings(ctx: ExtensionCommandContext): Promise<void> {
  const current = resolveSettings(loadSettings());
  const available = ctx.modelRegistry
    .getAvailable()
    .map((model) => `${model.provider}/${model.id}`);
  const patch: Record<string, unknown> = {};

  const checkpointEscape = keepCurrent(current.checkpointModel !== undefined);
  const checkpointModel = await ctx.ui.select(
    `Debloat: checkpoint model (now ${modelLabel(current.checkpointModel)})`,
    [...available, checkpointEscape],
  );
  if (checkpointModel === undefined) return;
  if (checkpointModel !== checkpointEscape) {
    const ref = parseModelChoice(checkpointModel);
    if (!ref) return;
    patch.checkpointModel = ref;
  }

  const checkpointThinking = await ctx.ui.select(
    `Debloat: checkpoint thinking level (now ${current.checkpointThinkingLevel})`,
    [...THINKING_LEVELS],
  );
  if (checkpointThinking === undefined) return;
  patch.checkpointThinkingLevel = checkpointThinking;

  const compactEscape = keepCurrent(current.compactModel !== undefined);
  const compactModel = await ctx.ui.select(
    `Debloat: compact model (now ${modelLabel(current.compactModel)})`,
    [...available, compactEscape],
  );
  if (compactModel === undefined) return;
  if (compactModel !== compactEscape) {
    const ref = parseModelChoice(compactModel);
    if (!ref) return;
    patch.compactModel = ref;
  }

  const compactThinking = await ctx.ui.select(
    `Debloat: compact thinking level (now ${current.compactThinkingLevel})`,
    [...THINKING_LEVELS],
  );
  if (compactThinking === undefined) return;
  patch.compactThinkingLevel = compactThinking;

  const tokenChoice = await ctx.ui.select(
    `Debloat: max lookback tokens (now ${current.maxLookbackTokens})`,
    [...TOKEN_CHOICES.map(String), CUSTOM_TOKENS],
  );
  if (tokenChoice === undefined) return;
  let maxTokens: number | undefined;
  if (tokenChoice === CUSTOM_TOKENS) {
    const typed = await ctx.ui.input("Debloat: max lookback tokens (digits)");
    if (typed === undefined) return;
    maxTokens = parseTokenChoice(typed);
    if (maxTokens === undefined) {
      ctx.ui.notify("Debloat: expected a positive number of tokens.", "error");
      return;
    }
  } else {
    maxTokens = parseTokenChoice(tokenChoice);
    if (maxTokens === undefined) return;
  }
  patch.maxLookbackTokens = maxTokens;

  // Use `saveSettings`'s own default-layer resolution: forcing "project" would
  // create a stray `<cwd>/.pi/debloat.json` and make the global layer unreachable.
  const target = defaultSettingsFile();
  const saved = resolveSettings(saveSettings(patch));
  ctx.ui.notify(
    [
      `Debloat settings saved to ${target}:`,
      `  checkpoint: ${modelLabel(saved.checkpointModel)} @ ${saved.checkpointThinkingLevel}`,
      `  compact:    ${modelLabel(saved.compactModel)} @ ${saved.compactThinkingLevel}`,
      `  lookback:   ${saved.maxLookbackTokens} tokens`,
    ].join("\n"),
    "info",
  );
}

function renderTimeline(state: DebloatState, leafId: string | null): string | null {
  const lines: string[] = ["Debloat timeline"];
  if (state.hasTombstone) {
    lines.push(`tombstones: ${state.removedCheckpointCount} checkpoint(s) removed`);
  }
  if (state.checkpoints.length === 0) {
    if (lines.length === 1) return null;
    lines.push("checkpoints: none");
  } else {
    lines.push(`checkpoints (${state.checkpoints.length}):`);
    for (const checkpoint of state.checkpoints) {
      const compacted = state.compactions.some(
        (c) =>
          c.fromAfterEntryId === checkpoint.afterEntryId ||
          c.toAfterEntryId === checkpoint.afterEntryId,
      );
      const mark = checkpoint.stale ? "  " : compacted ? "[x]" : "[ ]";
      const suffix = checkpoint.stale ? "  (stale)" : "";
      lines.push(`${mark} ${checkpoint.label}${suffix}`);
    }
  }

  lines.push(`summaries (${state.compactions.length}):`);
  for (const compaction of state.compactions) {
    lines.push(
      `  ${compaction.title}  ${compaction.fromAfterEntryId}→${compaction.toAfterEntryId}`,
    );
  }

  const { newestRaw } = computeSpans(state, leafId ?? "");
  if (newestRaw) {
    // `computeSpans` always supplies a string label; the `??` is defensive only.
    const from = newestRaw.fromLabel ?? "session start";
    lines.push(`raw: ${from} → current`);
  } else {
    lines.push("raw: session start → current");
  }
  return lines.join("\n");
}

async function runTimeline(ctx: ExtensionCommandContext): Promise<void> {
  const state = readState(ctx);
  const text = renderTimeline(state, currentLeafId(ctx));
  if (text === null) {
    ctx.ui.notify("Debloat: no checkpoints to show — run /checkpoint-make first.", "info");
    return;
  }
  ctx.ui.notify(text, "info");
}

async function runRemoveCheckpoints(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const state = readState(ctx);
  const count = state.checkpoints.length;
  if (count === 0) {
    ctx.ui.notify("Debloat: no checkpoints to remove.", "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Remove checkpoints",
    `Ignore all ${count} checkpoint(s)? Summaries stay in effect.`,
  );
  if (!confirmed) {
    ctx.ui.notify("Debloat: nothing changed.", "info");
    return;
  }
  pi.appendEntry(TOMBSTONE_CUSTOM_TYPE, { removedCheckpoints: count });
  ctx.ui.notify(`Debloat: removed ${count} checkpoint(s). Summaries stay in effect.`, "info");
}

export async function runDebloat(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const subcommand = args.trim();
  try {
    if (subcommand === "settings") {
      await runSettings(ctx);
    } else if (subcommand === "timeline") {
      await runTimeline(ctx);
    } else if (subcommand === "remove-checkpoints") {
      await runRemoveCheckpoints(pi, ctx);
    } else {
      ctx.ui.notify(DEBLOAT_USAGE, "info");
    }
  } catch (error) {
    ctx.ui.notify(`Debloat: ${errorText(error)}`, "error");
  }
}
