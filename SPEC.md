# Spec: Debloat — manual checkpoint & range-compaction extension for pi

> Source intent: [docs/intent/debloat.md](docs/intent/debloat.md)
> Scope check: single cohesive capability (one extension, one shared session-entry data model, one consumer). No capability map needed.

## Objective

Debloat gives a pi user manual, fine-grained control over how much raw conversation the LLM sees. Instead of pi's single opaque `/compact`, the user:

1. Runs `/checkpoint-make` — a configured sub-model reads the recent context (capped by token budget) and places multiple labeled **checkpoint markers** at semantic task boundaries.
2. Runs `/compact-checkpoint` — a configured sub-model compacts each uncompacted checkpoint-to-checkpoint span into a titled summary. Raw messages in compacted spans stop being sent to the LLM; summaries are injected in their place. The newest span (latest checkpoint → current) is always left raw.

Everything is user-triggered. No automation, no background triggers.

**LLM-visible result:**

```
Before compact:  [raw A..B][raw B..C][raw C..D][raw D..current]
After compact:   [summary A-B][summary B-C][summary C-D][raw D..current]
```

## Tech Stack

- TypeScript extension module loaded by pi (`ExtensionAPI` from `@earendil-works/pi-coding-agent`).
- `@earendil-works/pi-ai` for one-shot LLM calls via `ctx.modelRegistry.getProvider(providerId).streamSimple(model, context, options)`.
- No other runtime dependencies. Node built-ins for fs/path.
- Tests: vitest.

## Key Design Decisions

### D1 — Session data model (append-only, logical positions)

The session is an append-only tree; entries cannot be deleted. Debloat state is therefore *derived* from custom entries appended at the current leaf:

| Entry (`customType`) | Data | Meaning |
|---|---|---|
| `debloat-checkpoint` | `{ afterEntryId, label }` | A checkpoint marker logically placed *after* the message entry with id `afterEntryId`. Appended at the leaf, but its logical position is derived from `afterEntryId`. |
| `debloat-compaction` | `{ fromAfterEntryId, toAfterEntryId, title, summary, usage? }` | One compacted span: covers message entries logically after `fromAfterEntryId` up to and including `toAfterEntryId`. |
| `debloat-tombstone` | `{ removedCheckpoints: number }` | Written by `/debloat remove-checkpoints`. All checkpoint entries earlier on the branch are ignored for state computation. Compaction entries are NOT removed (per intent: summaries stay in effect). |

Compacted spans may not overlap. Ranges are computed from checkpoint positions on the current branch.

### D2 — Context assembly happens in the `context` event

Raw messages stay in the session file forever. On each `context` event the extension rebuilds the message list from `ctx.sessionManager` branch entries + derived debloat state:

- Messages inside a compacted span are dropped.
- One synthetic message (role `user`, prefixed `[Debloat summary <from>→<to>: <title>]` + summary text) is injected at the position of the earliest dropped message in that span.
- Native pi compaction is respected: use `buildContextEntries()` semantics — if a native `CompactionEntry` cut point exists, messages before it are already absent; checkpoints logically before the native cut point are **stale** and are pruned from active state (shown as consumed in the timeline).

### D3 — One-shot LLM calls (no agent loop)

Both phases are pure "read transcript, emit judgment" calls:

- Provider/model/thinking level come from settings; resolved via `ctx.modelRegistry.getProvider(...)`.
- Prompt = bundled skill file (read from disk at call time so the user can edit it) + formatted transcript with per-message entry ids.
- Output parsed as JSON; invalid output → one retry with a validation-error follow-up, then fail with a notify.
- Usage from the call is stored on the `debloat-compaction` entry so session token totals include summarization work.

### D4 — Settings

Stored in two layers, shallow-merged per key (project wins):

- Global: `~/.pi/agent/debloat.json` (machine-level model prefs)
- Project: `<project>/.pi/debloat.json` (per-project overrides)

```json
{
  "checkpointModel": { "provider": "anthropic", "modelId": "..." },
  "checkpointThinkingLevel": "low",
  "compactModel": { "provider": "anthropic", "modelId": "..." },
  "compactThinkingLevel": "low",
  "maxLookbackTokens": 100000
}
```

Defaults: thinking levels `low`, `maxLookbackTokens` 100000. A key present in the project file overrides the same key from the global file; all other keys fall through. Model pickers list models available from `ctx.modelRegistry`.

### D5 — Token budget for `/checkpoint-make`

Walk backwards from the current leaf accumulating **per-message** token estimates until `maxLookbackTokens` is reached, always keeping at least 2 messages when that many are eligible (a boundary needs one message on each side). Each message is charged its own size — `usage.output` when present, `≈ chars/4` fallback — never `usage.totalTokens`, which pi sets to the cumulative request total and which would let one assistant message consume the whole budget. The window starts at the logical position of the most recent active checkpoint if one exists (its `afterEntryId`), otherwise at session start.

### D6 — Progress indicator above the editor

Both commands make one-shot LLM calls while the agent is idle. pi's built-in
working spinner only renders on `turn_start` while `session.isStreaming`, and an
extension command handler runs *before* that (`_tryExecuteExtensionCommand`), so
`setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` never show
anything here. `/compact-checkpoint` makes one call per span, so silence can last
minutes.

Therefore progress is surfaced as a **widget above the editor** (above the text
input), one shared key `debloat-progress`, built from the `Loader` component in
`@earendil-works/pi-tui` (animated spinner + message + elapsed seconds):

```
  ⠹ compacting 2/3 — "api-layer" → "tests"  (12s)
<text input>
```

| Command | Widget lifecycle |
|---|---|
| `/checkpoint-make` | `planning checkpoints — N message(s), ~T token(s)…`, shown for the duration of the model call, then cleared and the existing notify. |
| `/compact-checkpoint` | `compacting i/N — "from" → "to"` (updated once per span) → cleared, then the summary notify. |

Rules (all mandatory):

- Exactly one widget key, so the two commands can never stack rows; a second
  `setWidget("debloat-progress", …)` must not be required to clear a previous one.
- Cleared with `setWidget("debloat-progress", undefined)` on **every** exit path —
  the normal end, every early `return`, and the `catch` — via `finally`.
- Never touches pi's footer status: `index.ts` owns `setStatus("debloat", …)` for
  the checkpoint/span counts, so the commands do not overwrite it.
- Best-effort: guarded by `ctx.hasUI` and `try/catch`, because a progress row is
  never worth failing a command. In RPC mode `setWidget` is pi's no-op.
- The row is first painted on the next render tick, so only phases that overlap
  an `await` are visible; synchronous work (context reads, `appendEntry` fan-out)
  must not be advertised as a phase.

## Commands

| Command | Behavior |
|---|---|
| `/checkpoint-make` | Build lookback window (D5). If window has no placeable messages → notify. One-shot call with `find-checkpoint.md`, progress per D6. Validate returned boundaries (valid entry ids, cut-point rules: never split a user→toolResult pair, boundaries strictly after any existing checkpoint positions and before current). Append `debloat-checkpoint` entries. Notify with placed count + labels. |
| `/compact-checkpoint` | If no active checkpoints → notify "no checkpoints, run /checkpoint-make first". Determine spans: oldest uncompacted checkpoint → latest checkpoint; compact each span sequentially (one LLM call per span, `compact.md` prompt). Append `debloat-compaction` entry per span. Newest span (latest checkpoint → current) is never compacted. Show progress per span via the D6 widget. |
| `/debloat settings` | TUI: one settings table (label → current value) that edits all values in place — checkpoint/compact model pickers, thinking levels, lookback tokens — each accepted edit written immediately to the settings file, then one summary notify on close; Esc closes (nothing is staged, so nothing is lost). Non-TUI (RPC/print): the sequential picker dialogs as a fallback. Saves to D4 file. |
| `/debloat timeline` | Render list: checkpoints in logical order with labels, compaction titles per span, stale/consumed marks, tombstone state. |
| `/debloat remove-checkpoints` | Confirm dialog → append `debloat-tombstone` → notify count removed. Compaction summaries unaffected. |
| `/debloat` (no args) | Show usage summary of the subcommands. |

## Project Structure

```
context-manage/
├── src/
│   ├── index.ts          # Extension entry: registers commands, context event, session_start restore
│   ├── state.ts          # Derive debloat state from branch entries (checkpoints, compactions, tombstones, staleness)
│   ├── ranges.ts         # Pure span/range math: window capping, span computation, cut-point validation
│   ├── llm.ts            # One-shot streamSimple wrapper + JSON parsing/retry
│   ├── progress.ts       # D6 spinner widget above the editor (Loader + elapsed time)
│   ├── context-build.ts  # context-event message rebuild (filter compacted, inject summaries)
│   ├── settings.ts       # Load/save ~/.pi/agent/debloat.json with defaults
│   └── commands/         # checkpoint-make.ts, compact-checkpoint.ts, debloat.ts (settings/timeline/remove)
├── skills/
│   ├── find-checkpoint.md   # Prompt for boundary placement (JSON output schema)
│   └── compact.md           # Prompt for span summarization (title + structured summary)
├── test/                    # vitest unit tests (state, ranges, context-build, llm parsing)
├── docs/intent/debloat.md
├── SPEC.md
├── tasks/plan.md
├── tasks/todo.md
└── package.json
```

## Code Style

TypeScript, ESM, strict. Pure functions separated from pi-API glue so logic is unit-testable without pi.

```typescript
// Pure, testable: no pi imports
export function computeSpans(
  checkpoints: Checkpoint[],
  compactions: Compaction[],
  currentLeafId: string,
): { compactable: Span[]; newestRaw: Span | null } { ... }

// Glue at the edge
pi.registerCommand("checkpoint-make", {
  description: "Place checkpoints via sub-model",
  handler: async (_args, ctx) => {
    const settings = loadSettings();
    const window = buildLookbackWindow(ctx.sessionManager, settings.maxLookbackTokens);
    ...
  },
});
```

Conventions: kebab-case files, named exports, no default export except the extension entry factory, errors surfaced via `ctx.ui.notify(..., "error")`, never thrown into pi's handler void.

## Testing Strategy

- Framework: vitest, `test/*.test.ts`.
- Unit (required, no mocks of pi needed): `ranges.ts` (window capping, span math, edge cases: no checkpoints, all compacted, mid-tool-pair boundaries, stale-after-native-compaction), `state.ts` (tombstones, overlapping-span rejection, staleness), `context-build.ts` (filtering + injection, order stability), `llm.ts` JSON parsing (valid, malformed, retry).
- Glue (commands, settings IO, streamSimple wrapper) verified manually:
  - `pi --extension ./src/index.ts` (or `pi install` from the package dir) in a scratch session.
- Coverage: all pure logic covered; no coverage percentage target.

## Boundaries

- **Always:** run `npx vitest run` before declaring a task done; validate LLM JSON output; keep raw messages in the session file (never destructive); respect native compaction cut points; confirm before any state-changing command that removes data.
- **Ask first:** adding runtime dependencies (the D6 widget reuses the already-used
  `@earendil-works/pi-tui` `Loader`); changing the custom-entry data schema (breaking existing sessions); writing outside `~/.pi/agent/debloat.json` and the project dir.
- **Never:** delete or rewrite session entries; trigger LLM calls without the user running a command; inject checkpoint/summary content into the main conversation as visible chat messages; suppress pi's native auto-compaction.

## Success Criteria

1. `/checkpoint-make` in a session with ≥3 turns appends 1+ `debloat-checkpoint` entries whose labels reflect content, using the configured checkpoint model/thinking level.
2. `/checkpoint-make` with no prior checkpoint caps the scanned context at `maxLookbackTokens` (verified via log/notify of scanned span).
3. `/compact-checkpoint` without checkpoints notifies and does nothing.
4. `/compact-checkpoint` with checkpoints A,B,C,D compacts [A-B],[B-C],[C-D] and leaves D→current raw.
5. After compaction, a subsequent LLM request's message list (inspectable via `context` event logging) contains summary messages in place of compacted raw messages, in correct order.
6. `/debloat timeline` lists checkpoints, span titles, compacted/consumed status.
7. `/debloat remove-checkpoints` asks for confirmation; after it, checkpoints are gone from state/timeline but summaries still apply in the LLM context.
8. A native pi compaction between checkpoints marks pre-cut checkpoints consumed; commands keep working.
9. `npx vitest run` passes; `npx tsc --noEmit` passes.
10. While `/checkpoint-make` or `/compact-checkpoint` waits on a model call in the
    TUI, an animated spinner row with the current phase is visible above the text
    input (`/compact-checkpoint` shows `compacting i/N` per span).
11. The progress row is gone when the command ends — on success, on a mid-loop
    failure, and on an exception — i.e. `setWidget("debloat-progress", undefined)`
    is called exactly once per run and the footer status is left to `index.ts`.

## Open Questions

- None blocking. (Deferred niceties, not in scope: entry renderers for checkpoints in the chat transcript; parallel compaction of spans; project-level settings override.)
