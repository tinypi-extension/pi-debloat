# Debloat — manual checkpoint & range-compaction for pi

A pi extension that gives you hand-controlled context slimming. Instead of pi's single opaque `/compact` (one cut point, one lump of summary), Debloat lets a sub-model place **labeled checkpoint markers** at semantic task boundaries, then compacts each checkpoint-to-checkpoint span into a titled summary.

```
Before:  [raw A..B][raw B..C][raw C..D][raw D..current]
After:   [summary A-B][summary B-C][summary C-D][raw D..current]
```

Everything is user-triggered. No automation, no background compaction.

- Raw messages are **never deleted** — they stay in the session file forever.
- Compacted spans are only **filtered out of the LLM context** and replaced by one injected summary message per span.
- The newest span (latest checkpoint → current) is always left raw, so the model always sees fresh conversation verbatim.
- pi's native auto-compaction is respected, not suppressed. A native cut point makes earlier checkpoints *stale* (they show as consumed in the timeline).

## Install

### Option 1 — run it from a local clone (quickest)

```bash
git clone git@github.com:tinypi-extension/pi-debloat.git ~/.pi/agents/extension/
```

### Option 2 — install as a pi package (persistent, recommended)

```bash
pi install git:github.com/tinypi-extension/pi-debloat.git
```

## Usage

### 1. Configure (optional)

```
/debloat settings
```

Opens a settings table; every accepted edit is written immediately, and one summary is reported when you close it. Esc closes with nothing staged.

| Setting | Default | Meaning |
|---|---|---|
| Checkpoint model | *(unset)* | Model that places boundary markers — **required** |
| Checkpoint thinking | `low` | Thinking level for the checkpoint call |
| Compact model | *(unset)* | Model that writes span summaries — **required** |
| Compact thinking | `low` | Thinking level for the compaction calls |
| Max lookback tokens | `100000` | Token budget for the context scanned by `/checkpoint-make` |

Model pickers list every model available from pi's model registry. Non-TUI modes (RPC/print) fall back to sequential picker dialogs. Running a command before its model is configured notifies `no checkpoint model configured — run /debloat settings.` and does nothing else.

### 2. Place checkpoints

```
/checkpoint-make
```

A configured sub-model reads the recent context (capped by `maxLookbackTokens`) and appends one `debloat-checkpoint` entry per semantic boundary, each with a short label. Boundaries are validated before anything is written: valid entry ids, never splitting a `user → toolResult` pair, strictly after existing checkpoint positions and before the current leaf.

Progress appears as a spinner above the text input:

```
  ⠹ planning checkpoints — 42 message(s), ~18k token(s)…
<text input>
```

Then a notify reports how many checkpoints were placed and their labels.

### 3. Compact the spans

```
/compact-checkpoint
```

Each uncompacted checkpoint-to-checkpoint span is summarized **one LLM call per span**, sequentially:

```
  ⠹ compacting 2/3 — "api-layer" → "tests"  (12s)
<text input>
```

Span `[A-B][B-C][C-D]` becomes summary messages; `D → current` stays raw. Without checkpoints it notifies and does nothing. Summaries are injected into the LLM context at the position of the earliest dropped message in the span, so ordering stays stable. Token usage from each summarization call is recorded on the compaction entry, so session totals include summarization work.

### 4. Inspect and undo

| Command | What it does |
|---|---|
| `/debloat timeline` | Checkpoints in logical order, span titles, compacted / stale marks, tombstone state |
| `/debloat remove-checkpoints` | Confirm dialog → tombstones all current checkpoints. **Summaries stay in effect.** |
| `/debloat` | Usage summary of the subcommands |

`remove-checkpoints` removes markers only — it is not a way to un-summarize. Raw messages remain in the session file throughout, so nothing is ever lost.

## Commands

| Command | Behavior |
|---|---|
| `/checkpoint-make` | Build a token-capped lookback window → one-shot boundary call → validate → append `debloat-checkpoint` entries → notify |
| `/compact-checkpoint` | Resolve spans from active checkpoints → one-shot call per span → append `debloat-compaction` entries; newest span left raw |
| `/debloat settings` | Settings table (TUI) or sequential dialogs (RPC/print) |
| `/debloat timeline` | Render checkpoint / summary timeline |
| `/debloat remove-checkpoints` | Confirm → append `debloat-tombstone` |
| `/debloat` | Usage |

Footer status (`N checkpoints / M spans`) is owned by the extension entry point; the commands never overwrite it.

## Settings files

Two layers, shallow-merged per key (project wins):

- Global: `~/.pi/agent/debloat.json`
- Project: `<project>/.pi/debloat.json`

```json
{
  "checkpointModel": { "provider": "anthropic", "modelId": "claude-sonnet-5" },
  "checkpointThinkingLevel": "low",
  "compactModel": { "provider": "anthropic", "modelId": "claude-haiku-4-5" },
  "compactThinkingLevel": "low",
  "maxLookbackTokens": 100000
}
```

Unknown keys are preserved. Unreadable / invalid JSON in a layer falls back to `{}` for that layer. `/debloat settings` writes to the project layer when `<cwd>/.pi/` exists, otherwise global.

## Development

```bash
npm install
npm test           # vitest run — 190 tests
npm run typecheck  # tsc --noEmit
```

Pure logic (`state.ts`, `ranges.ts`, `context-build.ts`, `llm.ts` parsing, `settings.ts`) is unit-tested without mocking pi. Command glue, settings IO, and the `streamSimple` wrapper are verified manually with `pi -e ./src/index.ts` in a scratch session.

## Design boundaries

- **Never** deletes or rewrites session entries, and never suppresses pi's native auto-compaction.
- Never calls an LLM unless you ran a command.
- Never injects checkpoint or summary content into the chat transcript as visible messages.
- Confirms before any state-changing command that removes data.
- Fails open: any handler exception returns `undefined`, leaving pi's native behavior intact.

See [SPEC.md](SPEC.md) for the full specification and [docs/intent/debloat.md](docs/intent/debloat.md) for the original intent.

## License

TBD
