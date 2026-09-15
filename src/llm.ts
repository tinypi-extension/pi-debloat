/**
 * One-shot LLM plumbing: JSON extraction, schema validation, single corrective
 * retry, transcript formatting and skill-file loading.
 *
 * Deliberately pi-free: the model call is injected as `LlmCall`, so everything
 * here is pure (except `readSkillFile`, which only touches the local fs) and
 * fully unit-testable with a fake caller.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EntryLike, MessageLike } from "./state.js";

export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  thinkingLevel: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type LlmCall = (request: LlmRequest) => Promise<{ text: string; usage?: unknown }>;

export interface CheckpointOutput {
  afterEntryId: string;
  label: string;
}

export interface CompactOutput {
  title: string;
  summary: string;
}

const DEFAULT_MAX_CHARS_PER_ENTRY = 2000;

/**
 * Generous per-entry budget for the compactor path. `skills/compact.md`
 * promises the compactor "full entry contents, not truncations", so callers
 * that summarize a span should pass this explicitly:
 * `formatTranscript(entries, { maxCharsPerEntry: COMPACT_MAX_CHARS_PER_ENTRY })`.
 * The judge keeps the tighter 2000-char default above.
 */
export const COMPACT_MAX_CHARS_PER_ENTRY = 20000;

/** Cap on rendered tool-call arguments inside the transcript. */
const TOOL_ARGS_MAX_CHARS = 300;

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Drop whole lines that are just a markdown code fence (``` or ```json). */
function stripCodeFences(text: string): string {
  if (!text.includes("```")) return text;
  return text
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n");
}

/**
 * Extract the first balanced `[...]`/`{...}` block, ignoring prose around it.
 * Tracks brace/bracket nesting and skips over string literals (including
 * escaped quotes) so braces inside strings do not unbalance the scan.
 */
function extractBalancedBlock(text: string): string | null {
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[" || ch === "{") {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.length === 0 || stack[stack.length - 1] !== ch) return null;
      stack.pop();
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse the first JSON block in `text`; never throws. */
export function parseJsonOutput<T = unknown>(
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, error: "empty model response" };
  }
  const block = extractBalancedBlock(stripCodeFences(text));
  if (block === null) {
    return { ok: false, error: "no JSON object or array found in the response" };
  }
  try {
    return { ok: true, value: JSON.parse(block) as T };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${errorText(error)}` };
  }
}

/** Validate the judge's checkpoint plan; a string result is an error message. */
export function validateCheckpoints(
  value: unknown,
): { afterEntryId: string; label: string }[] | string {
  if (!Array.isArray(value)) return "expected a JSON array of checkpoints";
  const checkpoints: CheckpointOutput[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isRecord(item)) return `checkpoint ${i} is not an object`;
    if (!nonEmptyString(item.afterEntryId)) {
      return `checkpoint ${i} has a missing or empty afterEntryId`;
    }
    if (!nonEmptyString(item.label)) return `checkpoint ${i} has a missing or empty label`;
    checkpoints.push({ afterEntryId: item.afterEntryId, label: item.label });
  }
  return checkpoints;
}

/** Validate the compactor's single summary object; a string result is an error. */
export function validateCompact(value: unknown): { title: string; summary: string } | string {
  if (!isRecord(value)) return "expected a JSON object with title and summary";
  if (!nonEmptyString(value.title)) return "missing or empty title";
  if (!nonEmptyString(value.summary)) return "missing or empty summary";
  return { title: value.title, summary: value.summary };
}

function correctivePrompt(original: string, error: string, previous: string): string {
  return [
    original,
    "",
    "Your previous reply was rejected:",
    error,
    "",
    "Previous reply:",
    previous,
    "",
    "Reply again with ONLY valid JSON (no prose, no code fences).",
  ].join("\n");
}

/**
 * One-shot request with a single corrective retry.
 *
 * Attempt 1 is parsed with `parseJsonOutput` and validated. On any failure a
 * second request carries the error and the first reply. A throw/rejection from
 * `call` is caught and returned as `{ ok: false }` — nothing escapes.
 */
export async function requestJson<T>(
  call: LlmCall,
  request: LlmRequest,
  validate: (value: unknown) => T | string,
): Promise<{ ok: true; value: T; usage?: unknown } | { ok: false; error: string }> {
  let firstText = "";
  let firstError: string;

  try {
    const first = await call(request);
    firstText = typeof first?.text === "string" ? first.text : "";
    const parsed = parseJsonOutput(firstText);
    if (parsed.ok) {
      const validated = validate(parsed.value);
      if (typeof validated !== "string") {
        return first.usage === undefined
          ? { ok: true, value: validated }
          : { ok: true, value: validated, usage: first.usage };
      }
      firstError = validated;
    } else {
      firstError = parsed.error;
    }
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }

  try {
    const retry = await call({ ...request, userPrompt: correctivePrompt(request.userPrompt, firstError, firstText) });
    const text = typeof retry?.text === "string" ? retry.text : "";
    const parsed = parseJsonOutput(text);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const validated = validate(parsed.value);
    if (typeof validated === "string") return { ok: false, error: validated };
    return retry.usage === undefined
      ? { ok: true, value: validated }
      : { ok: true, value: validated, usage: retry.usage };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/**
 * Truncate a body to `maxChars`, appending `[truncated <n>k chars]` where `n` is
 * the number of dropped characters rounded to the nearest thousand.
 */
export function truncateBody(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const removed = text.length - maxChars;
  const k = Math.max(1, Math.round(removed / 1000));
  return `${text.slice(0, maxChars)} [truncated ${k}k chars]`;
}

const ROLE_LABELS: Record<string, string> = {
  assistant: "AI",
  toolResult: "TOOL",
  custom: "CUSTOM",
};

function roleLabel(role: unknown): string {
  if (typeof role !== "string") return "USER";
  return ROLE_LABELS[role] ?? "USER";
}

/** Compact JSON for a tool call's arguments, truncated to a few hundred chars. */
function renderToolCallArgs(args: unknown): string {
  let json = "";
  try {
    const serialized = JSON.stringify(args);
    if (typeof serialized === "string") json = serialized;
  } catch {
    json = "";
  }
  if (json.length === 0) return "{}";
  if (json.length <= TOOL_ARGS_MAX_CHARS) return json;
  return `${json.slice(0, TOOL_ARGS_MAX_CHARS)}...`;
}

/**
 * Render one assistant tool call as `[tool <name> <compact-json-args>]`. The
 * exact commands/paths live in `arguments`, so dropping them loses the content
 * the compaction skill asks to preserve.
 */
function renderToolCall(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" && block.name.length > 0 ? block.name : "?";
  const args = "arguments" in block ? block.arguments : block.args;
  return `[tool ${name} ${renderToolCallArgs(args)}]`;
}

/** Flatten a message's content into a single line of text. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (isRecord(block) && block.type === "toolCall") parts.push(renderToolCall(block));
      else if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
      // Thinking blocks are deliberately omitted: they are private model
      // reasoning, not transcript content the compactor needs to preserve.
    }
    return parts.join(" ");
  }
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

function collapseToLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Render one line per entry: `[node <id>] <ROLE>  <body>`, with a trailing
 * `  ← HEAD` on the final entry. Bodies are collapsed to a single line and
 * truncated per `maxCharsPerEntry`.
 */
export function formatTranscript(
  entries: readonly EntryLike[],
  opts?: { maxCharsPerEntry?: number },
): string {
  const maxCharsPerEntry = opts?.maxCharsPerEntry ?? DEFAULT_MAX_CHARS_PER_ENTRY;
  const lines = entries.map((entry) => {
    const message: MessageLike | undefined = entry?.message;
    const role = roleLabel(message?.role);
    const body = truncateBody(collapseToLine(extractText(message?.content)), maxCharsPerEntry);
    return `[node ${entry?.id ?? ""}] ${role}  ${body}`;
  });
  if (lines.length > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1]}  ← HEAD`;
  }
  return lines.join("\n");
}

/**
 * Read a bundled skill file. Default resolution is relative to this module
 * (`../skills/<name>`) so the extension works from any cwd. Missing/unreadable
 * files yield `""` — callers decide how to surface that.
 */
export function readSkillFile(name: string, baseDir?: string): string {
  try {
    const path =
      baseDir !== undefined && baseDir.length > 0
        ? join(baseDir, name)
        : fileURLToPath(new URL(`../skills/${name}`, import.meta.url));
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
