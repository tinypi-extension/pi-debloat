/**
 * `/checkpoint-make` — one-shot judge call that places labeled checkpoint
 * markers on the current branch. Glue only: window/step math lives in the pure
 * modules.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { createCaller, currentLeafId, errorText } from "../pi-glue.js";
import {
  formatTranscript,
  readSkillFile,
  requestJson,
  truncateBody,
  validateCheckpoints,
} from "../llm.js";
import { buildLookbackWindow, sanitizeBoundaries } from "../ranges.js";
import { loadSettings, resolveSettings } from "../settings.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  deriveState,
  type EntryLike,
  type MessageLike,
} from "../state.js";

const TASK_FRAME_CHARS = 600;
const SKILL_FILE = "find-checkpoint.md";

function messageText(message: MessageLike | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (typeof block === "object" && block !== null && "text" in block) {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join(" ");
  }
  return "";
}

/** The task frame: the first user message inside the lookback window. */
function taskFrame(entries: readonly EntryLike[]): string {
  for (const entry of entries) {
    if (entry.message?.role === "user") {
      const text = messageText(entry.message).replace(/\s+/g, " ").trim();
      if (text.length > 0) return truncateBody(text, TASK_FRAME_CHARS);
    }
  }
  return "(not available)";
}

export async function runCheckpointMake(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  void args;
  try {
    const settings = resolveSettings(loadSettings());
    if (!settings.checkpointModel) {
      ctx.ui.notify(
        "Debloat: no checkpoint model configured — run /debloat settings.",
        "error",
      );
      return;
    }

    const entries = ctx.sessionManager.getBranch() as unknown as EntryLike[];
    const state = deriveState(entries);
    const window = buildLookbackWindow(entries, state, settings.maxLookbackTokens);
    if (window.entries.length < 2) {
      ctx.ui.notify(
        "Debloat: nothing to checkpoint — fewer than 2 messages in the lookback window.",
        "info",
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

    // The anchor may be a checkpoint or the native compaction cut point (Fix 1).
    const anchorLabel =
      window.startAfterEntryId === null
        ? null
        : (state.activeCheckpoints.find((c) => c.afterEntryId === window.startAfterEntryId)
            ?.label ?? null);
    const anchorSince =
      window.startAfterEntryId === null
        ? "session start"
        : anchorLabel !== null
          ? `checkpoint "${anchorLabel}"`
          : window.startAfterEntryId === state.nativeCutPointId
            ? "the native compaction cut"
            : `checkpoint "${window.startAfterEntryId}"`;
    const anchor =
      window.startAfterEntryId === null ? "session start" : `starting after ${anchorSince}`;
    const truncated = window.truncated ? " (window truncated by the token cap)" : "";
    // Criterion 2: the scanned span and token total belong in the user-facing
    // notify, not only inside the prompt.
    const scanned = `scanned ${window.entries.length} message(s) (~${window.tokens} tokens) since ${anchorSince}${truncated}`;

    const userPrompt = [
      `session task frame — "${taskFrame(window.entries)}"`,
      `anchor: ${anchor}`,
      `scanned: ${window.entries.length} messages, ~${window.tokens} tokens${truncated}`,
      "",
      formatTranscript(window.entries),
    ].join("\n");

    const caller = createCaller(ctx, settings.checkpointModel, settings.checkpointThinkingLevel);
    const result = await requestJson(
      caller.call,
      {
        systemPrompt,
        userPrompt,
        thinkingLevel: settings.checkpointThinkingLevel,
      },
      validateCheckpoints,
    );
    if (!result.ok) {
      ctx.ui.notify(`Debloat: checkpoint planning failed — ${result.error}`, "error");
      return;
    }

    const leafId = currentLeafId(ctx) ?? "";
    const boundaries = sanitizeBoundaries(entries, state, leafId, result.value);
    if (boundaries.length === 0) {
      ctx.ui.notify(`Debloat: no boundaries placed — ${scanned}.`, "info");
      return;
    }
    for (const boundary of boundaries) {
      pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, {
        afterEntryId: boundary.afterEntryId,
        label: boundary.label,
      });
    }
    ctx.ui.notify(
      `Debloat: placed ${boundaries.length} checkpoint(s): ${boundaries
        .map((b) => b.label)
        .join(", ")} — ${scanned}.`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(`Debloat: ${errorText(error)}`, "error");
  }
}
