# Implementation contract (frozen interfaces)

Authoritative source: [SPEC.md](../SPEC.md). This file pins module boundaries and signatures so
independent workers produce compiling, mutually consistent code. **Do not change a signature here
without updating this file and telling the orchestrator.**

Rules for every module:

- Pure modules (`state.ts`, `ranges.ts`, `context-build.ts`, `llm.ts`) must **not import pi at
  runtime** — type-only imports are fine. This keeps them unit-testable with plain vitest.
- pi-API glue lives at the edges: `src/commands/*.ts`, `src/index.ts`, `src/pi-glue.ts`.
- Named exports only. No default export except the extension factory in `src/index.ts`.
- Errors are surfaced with `ctx.ui.notify(msg, "error")`; never throw into a pi handler.
- Never delete or rewrite session entries; only append custom entries.
- kebab-case filenames; `strict` TypeScript; ESM.

## Session entry view (pure, pi-independent)

```ts
export interface MessageLike {
  role: string;                       // "user" | "assistant" | "toolResult" | "custom" | ...
  content?: unknown;                  // string or content-block array
  usage?: { totalTokens?: number; output?: number; [k: string]: unknown };
  timestamp?: number;
  [k: string]: unknown;
}

export interface EntryLike {
  id: string;
  parentId?: string | null;
  type: string;                       // "message" | "custom" | "compaction" | "branchSummary" | ...
  customType?: string;                // when type === "custom"
  data?: unknown;                     // when type === "custom"
  message?: MessageLike;              // when type === "message" (or customMessage entries)
  firstKeptEntryId?: string;          // when type === "compaction"
  summary?: string;                   // when type === "compaction" / "branchSummary"
}
```

## Custom entry schema (D1)

| customType | data |
|---|---|
| `debloat-checkpoint` | `{ afterEntryId: string; label: string }` |
| `debloat-compaction` | `{ fromAfterEntryId: string; toAfterEntryId: string; title: string; summary: string; usage?: unknown }` |
| `debloat-tombstone` | `{ removedCheckpoints: number }` |

Constants (exported from `src/state.ts`):
`CHECKPOINT_CUSTOM_TYPE`, `COMPACTION_CUSTOM_TYPE`, `TOMBSTONE_CUSTOM_TYPE`.

## `src/state.ts`

```ts
export interface Checkpoint { entryId: string; afterEntryId: string; label: string; stale: boolean }
export interface Compaction {
  entryId: string; fromAfterEntryId: string; toAfterEntryId: string;
  title: string; summary: string; usage?: unknown;
}
export interface DebloatState {
  checkpoints: Checkpoint[];        // ALL checkpoints, logical (branch) order, oldest -> newest
  activeCheckpoints: Checkpoint[];  // stale === false
  compactions: Compaction[];        // logical order, oldest -> newest
  removedCheckpointCount: number;   // number of checkpoints ignored by tombstones
  hasTombstone: boolean;
  nativeCutPointId: string | null;  // firstKeptEntryId of latest native compaction, else null
}
export function deriveState(entries: readonly EntryLike[], nativeCutPointId?: string | null): DebloatState;
```

Semantics (deterministic, never throws):

- Walk `entries` in array order. On `custom`/`debloat-tombstone`: every later-processed
  (i.e. earlier in the array) checkpoint that was not already ignored becomes ignored;
  `removedCheckpointCount += newly ignored count`; `hasTombstone = true`. Checkpoints appended
  *after* a tombstone entry are active.
- Stale rule: a (non-ignored) checkpoint is stale when its logical position is before the native
  cut point — `position(checkpoint.afterEntryId) < position(nativeCutPointId)`. If
  `nativeCutPointId` is null → nothing is stale. If `afterEntryId` is not found in `entries` →
  stale (defensive).
- Overlapping compaction spans: later compaction whose `[from,to]` interval overlaps an
  already-accepted compaction's interval is **rejected** (dropped). Same-interval duplicates are
  also rejected (keep the older one).
- Malformed `data` (missing/incorrect-typed fields) => that entry is skipped, no throw.
- `checkpoints` keeps ignored/removed ones? **No** — ignored checkpoints are removed from
  `checkpoints`; `removedCheckpointCount` records how many. Stale checkpoints stay in
  `checkpoints` with `stale: true`.

## `src/ranges.ts`

```ts
export interface Span {
  fromAfterEntryId: string; toAfterEntryId: string;
  fromLabel: string | null; toLabel: string;
}
export function computeSpans(state: DebloatState, currentLeafId: string):
  { compactable: Span[]; newestRaw: Span | null };

export function isToolPairSplit(entries: readonly EntryLike[], afterEntryId: string): boolean;

export function sanitizeBoundaries(
  entries: readonly EntryLike[], state: DebloatState, currentLeafId: string,
  candidates: readonly { afterEntryId: string; label: string }[],
): { afterEntryId: string; label: string }[];

export function estimateTokens(message: MessageLike | undefined): number;

/** Minimum messages the judge needs to place a boundary between two of them. */
export const MIN_WINDOW_MESSAGES: number;

export function buildLookbackWindow(
  entries: readonly EntryLike[], state: DebloatState, maxTokens: number,
): { entries: EntryLike[]; startAfterEntryId: string | null; truncated: boolean; tokens: number };

export function messageIndexMap(entries: readonly EntryLike[]): (string | null)[];

export function isMessageEntry(entry: EntryLike): boolean;
```

Semantics:

- `computeSpans`: uses **active** checkpoints only, oldest→newest. Spans are
  `[cp[i].afterEntryId → cp[i+1].afterEntryId]` for `i = 0..n-2` with
  `fromLabel = cp[i].label`, `toLabel = cp[i+1].label`. A span already covered by an existing
  compaction (same `fromAfterEntryId` **and** `toAfterEntryId`) is excluded from `compactable`.
  `newestRaw = { fromAfterEntryId: cp[n-1].afterEntryId, toAfterEntryId: currentLeafId,
  fromLabel: cp[n-1].label, toLabel: "current" }`. No active checkpoints → `{ compactable: [],
  newestRaw: null }`. n === 1 → `compactable: []` and `newestRaw` set.
- `isToolPairSplit`: true when the entry **immediately following** `afterEntryId` in `entries` is a
  tool-result message (role `"toolResult"`), i.e. the cut would separate an assistant tool call
  from its result. Unknown `afterEntryId` → true (treat as invalid).
- `sanitizeBoundaries`: drop candidates whose `afterEntryId` is absent from `entries`, equals
  `currentLeafId`, or is positioned at/after `currentLeafId`; drop non-kebab-case/empty labels;
  drop candidates not strictly after the newest active checkpoint's `afterEntryId`; drop
  tool-pair splits; dedupe by `afterEntryId`; preserve remaining input order.
- `estimateTokens`: per-message cost, never the whole request — `usage.output` when it is a
  finite positive number, else `Math.ceil(chars / 4)` where
  `chars = JSON.stringify(message.content).length`. `usage.totalTokens` is deliberately ignored:
  pi sets it to the cumulative request total (input + cache + output for the whole context at
  that moment), so a single assistant message would otherwise consume the entire budget.
- `buildLookbackWindow`: message entries only (`isMessageEntry`). Walk backwards from the leaf.
  The eligible window starts strictly after the newest **active** checkpoint's `afterEntryId`
  (or at session start when none). Accumulate from newest to oldest, stop once accumulated tokens
  exceed `maxTokens` **and** at least `MIN_WINDOW_MESSAGES` (= 2) messages are kept (a single
  oversized message must never be the whole window); `truncated` = true when messages were
  dropped by the cap. Return the kept entries in forward (oldest→newest) order, `tokens` = sum of
  estimates of kept entries, `startAfterEntryId` = the window's exclusive start anchor.
- `messageIndexMap`: one slot per LLM-visible message, in order; the slot value is the source
  entry id, or `null` for entries that contribute no message. Entries contributing exactly one
  message: `type === "message"`, `type === "compaction"`, `type === "branchSummary"`, and custom
  message entries (`type === "customMessage"` or entries whose message role is `"custom"`).
  Everything else (`custom`, label, model-change, thinking-level, session-info) is skipped
  without producing a slot. Arrays whose length disagrees with pi's real message list must be
  detected by the caller (fail-open), never by throwing here.
- `isMessageEntry(entry)`: true when `entry.type === "message"` and `entry.message` is present.

## `src/context-build.ts`

```ts
export const DEBLOAT_PREFIX = "[Debloat summary ";
export function formatSummaryContent(
  fromAfterEntryId: string, toAfterEntryId: string, title: string, summary: string): string;
export interface IndexedMessage { entryId: string | null; message: MessageLike }
export function applyCompactions(
  items: readonly IndexedMessage[], state: DebloatState,
  entryOrder: readonly string[],
): IndexedMessage[];
export function rebuildMessages(
  messages: readonly MessageLike[],
  indexMap: readonly (string | null)[],
  state: DebloatState,
  entryOrder: readonly string[],
): { messages: MessageLike[]; applied: number } | null;
```

Semantics:

- `formatSummaryContent` =>
  `[Debloat summary <from>→<to>: <title>]\n\n<summary>` (literal `→`).
- Span membership: an item is inside a compaction span when its entry's index in `entryOrder`
  (via `entryId`) is `> index(fromAfterEntryId)` and `<= index(toAfterEntryId)`. A compaction
  whose endpoints are missing from `entryOrder`, or whose span contains no messages, is **skipped**
  (fail-open, count it as not applied).
- Applied compaction: all span messages are dropped and exactly one synthetic message is inserted
  at the position of the earliest dropped message:
  `{ role: "user", content: formatSummaryContent(...), timestamp: Date.now() }` — injected with the
  same `entryId` as the span's `toAfterEntryId` (so `indexMap` stays alignable).
- `applied` = number of compaction spans actually applied.
- `rebuildMessages` returns `null` when `indexMap.length !== messages.length` (caller then keeps
  pi's original message list). Otherwise it zips messages with their entry ids and delegates to
  `applyCompactions`.

## `src/settings.ts`

Global `~/.pi/agent/debloat.json`, project `<cwd>/.pi/debloat.json`; shallow per-key merge, project
wins; unknown keys preserved on save.

```ts
export interface ModelRef { provider: string; modelId: string }
export interface DebloatSettings {
  checkpointModel?: ModelRef;
  checkpointThinkingLevel?: string;   // default "low"
  compactModel?: ModelRef;
  compactThinkingLevel?: string;      // default "low"
  maxLookbackTokens?: number;         // default 100_000
  [k: string]: unknown;
}
export const DEFAULT_SETTINGS: Required<Pick<DebloatSettings,
  "checkpointThinkingLevel" | "compactThinkingLevel" | "maxLookbackTokens">>;
export function loadSettings(opts?: { cwd?: string; home?: string }): DebloatSettings;
export function saveSettings(patch: Partial<DebloatSettings>,
  opts?: { cwd?: string; home?: string; layer?: "global" | "project" }): DebloatSettings;
export function resolveSettings(settings: DebloatSettings): {
  checkpointModel?: ModelRef; checkpointThinkingLevel: string;
  compactModel?: ModelRef; compactThinkingLevel: string; maxLookbackTokens: number;
};
```

- `loadSettings` never throws: missing file, unreadable file, or invalid JSON → `{}` for that
  layer (still merged with the other layer + defaults applied via `resolveSettings`).
- `saveSettings` writes only the given patch keys into the chosen layer (default `"project"` when
  `.pi/` exists in cwd, else `"global"`), creating parent directories; reads the existing file
  first so unknown/unrelated keys survive; returns the merged settings.

## `src/llm.ts`

pi-free: the caller injects a `call` function. No runtime pi imports.

```ts
export type LlmCall = (request: {
  systemPrompt: string;
  userPrompt: string;
  thinkingLevel: string;
  maxTokens?: number;
  signal?: AbortSignal;
}) => Promise<{ text: string; usage?: unknown }>;

export function parseJsonOutput<T = unknown>(text: string):
  { ok: true; value: T } | { ok: false; error: string };

export function validateCheckpoints(value: unknown): { afterEntryId: string; label: string }[] | string; // string = error message
export function validateCompact(value: unknown): { title: string; summary: string } | string;

export async function requestJson<T>(
  call: LlmCall,
  request: { systemPrompt: string; userPrompt: string; thinkingLevel: string; maxTokens?: number; signal?: AbortSignal },
  validate: (value: unknown) => T | string,
): Promise<{ ok: true; value: T; usage?: unknown } | { ok: false; error: string }>;

export function formatTranscript(
  entries: readonly EntryLike[], opts?: { maxCharsPerEntry?: number },
): string;

export function truncateBody(text: string, maxChars: number): string;
export function readSkillFile(name: string, baseDir?: string): string; // reads <pkgRoot>/skills/<name>
```

Semantics:

- `parseJsonOutput`: strips markdown code fences and surrounding prose, extracts the first balanced
  JSON `[...]`/`{...}` block, `JSON.parse`s it. Returns a readable `error` string on failure
  (never throws). Empty/whitespace input → error.
- `validateCheckpoints`: accepts an array of `{ afterEntryId, label }`; error string when not an
  array, when an item is not an object, or when `afterEntryId`/`label` are not non-empty strings.
- `validateCompact`: accepts one object with non-empty string `title` and `summary`.
- `requestJson`: first attempt → parse + validate. On failure, one corrective retry whose
  userPrompt appends the validation error and the original text, then final failure returns
  `{ ok: false, error }`. Never throws; a caller error from `call` is caught and returned as
  `{ ok: false, error }`.
- `formatTranscript`: one line per entry: `[node <entryId>] <ROLE>  <body>` where role is
  `USER | AI | TOOL | CUSTOM` (default `USER` for unknown roles, `AI` for assistant, `TOOL` for
  toolResult). Body = text blocks joined (`" "`), truncated by `truncateBody` with
  `[truncated <n>k chars]` sentinel; multi-line bodies collapsed to single lines. Last entry gets
  a trailing `  ← HEAD`.
- `readSkillFile`: `new URL("../skills/" + name, import.meta.url)` based resolution so the
  extension works from any cwd; returns `""` when the file cannot be read (caller notifies).

## Commands (`src/commands/*.ts`) — glue

```ts
export async function runCheckpointMake(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void>;
export async function runCompactCheckpoint(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void>;
export async function runDebloat(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void>; // settings | timeline | remove-checkpoints | usage
```

Each command builds its caller with `createCaller(ctx)` from `src/pi-glue.ts` and hides all
pi-specific detail there.

## `src/pi-glue.ts` — pi glue

```ts
export function createCaller(ctx: ExtensionCommandContext, ref: ModelRef, thinkingLevel: string):
  { call: LlmCall; modelLabel: string } // throws a descriptive Error when the model is unavailable
export function readState(ctx: ExtensionCommandContext | ExtensionContext, pi?: ExtensionAPI): DebloatState;
export function currentLeafId(ctx): string | null;
```

- `createCaller` resolves the model with `ctx.modelRegistry.find(ref.provider, ref.modelId)`; calls
  it with `ctx.modelRegistry.complete(model, context, options)` when available (auth resolved),
  falling back to `ctx.modelRegistry.getProvider(provider)!.streamSimple(...)` +
  `getApiKeyForProvider`, then `contentText`/text-block extraction and `usage` capture.
  `thinkingLevel` is passed as `reasoning` in the options object; unsupported values must degrade,
  not throw.
  *(Deliberate deviation from SPEC D3's literal `streamSimple`, recorded here: the registry's
  auth-resolved `complete()` is the robust path; `streamSimple` is the fallback.)*

## `src/index.ts`

- default export factory `(pi: ExtensionAPI) => void | Promise<void>`.
- `pi.registerCommand("checkpoint-make" | "compact-checkpoint")` plus `pi.registerCommand("debloat", { getArgumentCompletions })` returning `settings`, `timeline`, `remove-checkpoints`.
- `pi.on("context", ...)`: derive state from `ctx.sessionManager.getBranch()`, use
  `ctx.sessionManager.buildContextEntries()` for the active entry order (falling back to the raw
  branch when unavailable), `messageIndexMap(...)` for alignment, then `rebuildMessages(...)`.
  Any mismatch/exception → return `undefined` (fail-open; pi keeps its original list). Never throw.
- `pi.on("session_start", ...)`: derive state (log/notify only when `hasTombstone` or checkpoints
  exist), set a status line via `ctx.ui.setStatus("debloat", ...)` guarded by `ctx.hasUI`.

## Verification commands

- Focused: `npx vitest run test/<file>.test.ts`
- Full: `npx vitest run` and `npx tsc --noEmit`

## Post-review amendments — where this section disagrees with the text above, this section wins

An adversarial spec review plus a real-`SessionManager` integration test found defects; the fixes
landed in `src/` (all verified: `npx vitest run` 137 passed, `npx tsc --noEmit` clean).

1. **D3 call path is inverted.** PRIMARY = `ctx.modelRegistry.getProvider(id).streamSimple(model,
   context, options)` with `options.reasoning` from the configured thinking level (auth via
   `getApiKeyAndHeaders`, falling back to `getApiKeyForProvider`); `modelRegistry.complete()` is now
   the FALLBACK. Reason: in pi-ai only `streamSimple` reads `options.reasoning`
   (`pi-ai/dist/api/anthropic-messages.js:655-681`, `openai-completions.js:539`,
   `openai-responses.js:168`, `google-generative-ai.js:241`), so the old primary path made both
   thinking-level settings a silent no-op.
2. **Context alignment tolerates pi trimming messages.** `src/index.ts` derives the per-message
   entry-id map from pi's real `sessionEntryToContextMessages` projection and, when
   `event.messages.length` differs, reconciles it with a two-pointer end walk plus content
   fingerprints. This covers pi's retry path (`agent-session.js:2308` slices agent state but keeps
   the branch entry), which previously disabled Debloat for the rest of the session. Unreconcilable
   → fail-open `undefined`; recovered → exactly one warning notify per session (reset on
   `session_start`). Status line `N summary(s) applied` (hasUI-guarded) satisfies criterion 5's
   inspectability without log spam.
3. **Native cut point is respected by the window and by boundary validation.**
   `buildLookbackWindow` starts strictly after `max(newest active checkpoint, nativeCutPointId)` and
   excludes message ranges already covered by an accepted compaction; `sanitizeBoundaries` rejects
   candidates at/before the cut. Absent cut-point ids fall back to the previous behavior.
4. **`computeSpans` coverage is interval-overlap**, not exact-pair equality: shared helper
   `intervalsIntersect` uses the same half-open `(from, to]` rule as `state.ts`. Positions are
   reconstructed from `state.checkpoints` order (the frozen 2-arg signature has no `entries`), with
   exact-endpoint matching as the fallback for a span whose endpoint is not a checkpoint anchor.
5. **Transcript fidelity**: assistant `toolCall` blocks render as `[tool <name> <compact-json-args>]`
   (arguments truncated at 300 chars, single line); thinking blocks are dropped deliberately. New
   additive export `COMPACT_MAX_CHARS_PER_ENTRY = 20000`, used by `/compact-checkpoint`; the judge
   keeps the 2000-char default.
6. **Command-level behaviour added by the fixes**: after each appended compaction the state is
   re-derived and a rejected (overlapping) span is reported rather than counted as compacted; the
   post-run notify carries usage tokens/cost; `/checkpoint-make`'s notify carries the scanned
   span/token total (criterion 2); `/debloat timeline` marks a checkpoint compacted when it is
   either span endpoint; `/debloat settings` saves via `saveSettings`'s default-layer resolution and
   names the file actually written; the anchor label reads "the native compaction cut" when the
   window starts at a native cut point.
7. **Residual deviation (unfixed, needs a product decision)**: `skills/compact.md` promises "full
   entry contents, not truncations". The compactor now gets a 20 000 chars/entry budget (full for
   realistic entries) but is still technically capped, and the file was deliberately left unedited.
8. **`createCaller` fallback is pre-dispatch only** (low-severity cost fix): `resolveAuth` + the
   synchronous `streamSimple` call are wrapped separately from `await stream.result()`, so a
   rejection after the request was dispatched propagates instead of silently re-issuing it through
   `complete()`. The registry fallback is reachable only when `streamSimple` is unavailable or the
   setup threw. Covered by `test/commands.test.ts`.
