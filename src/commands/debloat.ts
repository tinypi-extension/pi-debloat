/**
 * `/debloat` — settings dialogs, timeline rendering and checkpoint removal.
 * The only command that writes settings; nothing here runs on its own.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Input, SelectList, SettingsList } from "@earendil-works/pi-tui";
import type { AutocompleteItem, Component, SettingItem } from "@earendil-works/pi-tui";
import {
  getSelectListTheme,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { currentLeafId, errorText, readState } from "../pi-glue.js";
import { computeSpans } from "../ranges.js";
import {
  loadSettings,
  resolveSettings,
  saveSettings,
  type DebloatSettings,
  type ModelRef,
  type ResolvedSettings,
} from "../settings.js";
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

/* ---------------------------------------------------- settings: shared helpers */

/** Stage one table edit into `patch`; unknown ids / unparseable values are ignored. */
export function applySettingChange(patch: DebloatSettings, id: string, value: string): void {
  switch (id) {
    case "checkpoint-model": {
      const ref = parseModelChoice(value);
      if (ref) patch.checkpointModel = ref;
      return;
    }
    case "compact-model": {
      const ref = parseModelChoice(value);
      if (ref) patch.compactModel = ref;
      return;
    }
    case "checkpoint-thinking":
      patch.checkpointThinkingLevel = value;
      return;
    case "compact-thinking":
      patch.compactThinkingLevel = value;
      return;
    case "lookback-tokens": {
      const tokens = parseTokenChoice(value);
      if (tokens !== undefined) patch.maxLookbackTokens = tokens;
      return;
    }
  }
}

/**
 * The SettingsList rows: label on the left, current value on the right. Rows
 * with `values` cycle in place; rows with `submenu` open a picker. `save` is the
 * only row whose activation writes anything.
 */
export function settingsTableItems(
  current: ResolvedSettings,
  available: string[],
  notifyError: (message: string) => void,
): SettingItem[] {
  return [
    {
      id: "checkpoint-model",
      label: "Checkpoint model",
      description: "Model that places checkpoints (/checkpoint-make)",
      currentValue: modelLabel(current.checkpointModel),
      submenu: (value, done) => new ModelSubmenu(available, value, done),
    },
    {
      id: "checkpoint-thinking",
      label: "Checkpoint thinking",
      description: "Reasoning level for boundary placement",
      currentValue: current.checkpointThinkingLevel,
      values: [...THINKING_LEVELS],
    },
    {
      id: "compact-model",
      label: "Compact model",
      description: "Model that writes span summaries (/compact-checkpoint)",
      currentValue: modelLabel(current.compactModel),
      submenu: (value, done) => new ModelSubmenu(available, value, done),
    },
    {
      id: "compact-thinking",
      label: "Compact thinking",
      description: "Reasoning level for span summaries",
      currentValue: current.compactThinkingLevel,
      values: [...THINKING_LEVELS],
    },
    {
      id: "lookback-tokens",
      label: "Max lookback tokens",
      description: "How much recent context /checkpoint-make scans",
      currentValue: String(current.maxLookbackTokens),
      submenu: (value, done) => new TokenSubmenu(value, done, notifyError),
    },
    {
      id: "save",
      label: "Save & exit",
      description: "Write settings and close (Esc cancels without writing)",
      currentValue: "press Enter to save",
      values: ["save"],
    },
  ];
}

/** Model picker: Enter selects the highlighted `provider/id`, Escape keeps current. */
class ModelSubmenu implements Component {
  private readonly list: SelectList;

  constructor(available: string[], currentValue: string, done: (value?: string) => void) {
    const items = available.map((value) => ({ value, label: value }));
    this.list = new SelectList(items, Math.min(items.length, 15), getSelectListTheme());
    const index = items.findIndex((item) => item.value === currentValue);
    if (index >= 0) this.list.setSelectedIndex(index);
    this.list.onSelect = (item) => done(item.value);
    this.list.onCancel = () => done();
  }

  render(width: number): string[] {
    return this.list.render(width);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

/**
 * Token picker: preset list plus an in-place numeric Input for the "custom…"
 * entry. Escape from the Input drops back to the preset list.
 */
class TokenSubmenu implements Component {
  private readonly list: SelectList;
  private input: Input | null = null;

  constructor(
    currentValue: string,
    done: (value?: string) => void,
    notifyError: (message: string) => void,
  ) {
    const items = [
      ...TOKEN_CHOICES.map((value) => ({ value: String(value), label: String(value) })),
      { value: CUSTOM_TOKENS, label: CUSTOM_TOKENS },
    ];
    this.list = new SelectList(items, items.length, getSelectListTheme());
    const index = items.findIndex((item) => item.value === currentValue);
    if (index >= 0) this.list.setSelectedIndex(index);
    this.list.onSelect = (item) => {
      if (item.value !== CUSTOM_TOKENS) {
        done(item.value);
        return;
      }
      this.showCustomInput(currentValue, done, notifyError);
    };
    this.list.onCancel = () => done();
  }

  private showCustomInput(
    currentValue: string,
    done: (value?: string) => void,
    notifyError: (message: string) => void,
  ): void {
    const input = new Input({ prompt: "Max lookback tokens: " });
    input.setValue(currentValue);
    input.onSubmit = (value) => {
      const parsed = parseTokenChoice(value);
      if (parsed === undefined) {
        notifyError("Debloat: expected a positive number of tokens.");
        return;
      }
      done(String(parsed));
    };
    input.onEscape = () => {
      this.input = null;
    };
    this.input = input;
  }

  private active(): Component {
    return this.input ?? this.list;
  }

  render(width: number): string[] {
    return this.active().render(width);
  }

  invalidate(): void {
    this.active().invalidate?.();
  }

  handleInput(data: string): void {
    this.active().handleInput?.(data);
  }
}

/**
 * The single post-save summary, shared by the table and the dialog fallback. It
 * re-resolves through `saveSettings` so the notify names the file actually
 * written (default-layer resolution, project layer only when `<cwd>/.pi` exists).
 */
function notifySettingsSaved(ctx: ExtensionCommandContext, patch: Partial<DebloatSettings>): void {
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

/**
 * TUI path: one SettingsList table. Edits accumulate in `patch`; only the Save
 * row writes. Escape closes silently with no write and no notify.
 */
async function runSettingsTui(ctx: ExtensionCommandContext): Promise<void> {
  const current = resolveSettings(loadSettings());
  const available = ctx.modelRegistry
    .getAvailable()
    .map((model) => `${model.provider}/${model.id}`);
  const patch: DebloatSettings = {};

  const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) => {
    const items = settingsTableItems(current, available, (message) =>
      ctx.ui.notify(message, "error"),
    );
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => {
        if (id === "save") {
          // Staged edits are flushed once by `notifySettingsSaved` below.
          done("saved");
          return;
        }
        applySettingChange(patch, id, value);
      },
      () => done(undefined),
    );
    return {
      render: (width) => list.render(width),
      invalidate: () => list.invalidate(),
      handleInput: (data) => list.handleInput(data),
    };
  });

  if (result === undefined) return;
  notifySettingsSaved(ctx, patch);
}

/**
 * Non-TUI fallback (RPC/print): the original five sequential dialogs, kept
 * because `ctx.ui.custom` is unavailable outside the TUI. Cancelling any dialog
 * aborts without writes.
 */
async function runSettingsDialogs(ctx: ExtensionCommandContext): Promise<void> {
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
  notifySettingsSaved(ctx, patch);
}

/** TUI gets the table; everywhere else keeps the sequential dialogs. */
async function runSettings(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode === "tui") {
    await runSettingsTui(ctx);
    return;
  }
  await runSettingsDialogs(ctx);
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
