# Intent: Debloat (pi extension)

Confirmed via interview-me, 2026. User confirmed with explicit yes.

- **Outcome:** A pi extension that gives manual, user-controlled context slimming: a configured sub-model places labeled checkpoint markers at semantic boundaries in recent conversation history, and later compacts each checkpoint-to-checkpoint span into a titled summary that replaces the raw messages in the LLM's context.
- **User:** The user alone, driving everything by hand — no automation, no background triggers.
- **Why now:** pi's built-in `/compact` is one opaque lump with one cut point; user wants fine-grained, inspectable compression with visible boundaries the model chose the placements of.
- **Success:** `/checkpoint-make` → model places boundaries (A…D) in the capped recent context; `/compact-checkpoint` → each uncompacted range becomes `[A-B][B-C][C-D]` summary messages, newest span (latest checkpoint → current) always left raw; LLM context actually shrinks; `/debloat timeline` shows every checkpoint/summary with labels.
- **Constraint:** Models/thinking levels for each phase configurable from pi's registered models (checkpoint default thinking: low; compact default: low); lookback cap default 100k tokens; one-shot pi-ai calls (no agent loop, nothing extra in main transcript); checkpoints stored as session entries, raw messages kept in the session file and only filtered from LLM context.
- **Out of scope:** Removing compact summaries via `remove-checkpoints` (markers only — summaries stay in effect), replacing/suppressing pi's native auto-compaction (treated as an opaque boundary; stale checkpoints pruned/annotated), any scheduled or threshold-triggered behavior, agent loops or tool use in the sub-model calls.

Commands: `/checkpoint-make`, `/compact-checkpoint` (errors if no checkpoints), `/debloat settings` (model pickers + thinking levels + lookback token), `/debloat timeline`, `/debloat remove-checkpoints` (with confirm dialog). Skills `find-checkpoint.md` and `compact.md` ship with the extension; content design delegated to the implementer.
