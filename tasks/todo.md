# Todo: Debloat

Status: **9/10 done.** Suite `npx vitest run` → 179 passed (8 files); `npx tsc --noEmit` clean;
extension loads through pi's own loader with zero errors. The remaining item is the live-session
walkthrough (needs model auth) — see the last task.

- [x] Task: Implement `src/ranges.ts` (lookback window capping, span computation, cut-point validation, staleness math) + `test/ranges.test.ts`
  - Acceptance: Pure functions per SPEC D5/D2; covers: no checkpoints, existing checkpoints, all-compacted, mid-tool-pair rejection, native-compaction staleness, 100k token cap.
  - Verify: `npx vitest run test/ranges.test.ts`
  - Files: src/ranges.ts, test/ranges.test.ts
  - Done: implemented; all acceptance cases covered. Extended in the fix pass with native-cut-point clamping (`buildLookbackWindow`, `sanitizeBoundaries`), interval-overlap span coverage, and exclusion of already-compacted message ranges.
- [x] Task: Implement `src/state.ts` (derive checkpoints/compactions/tombstones from branch entries) + `test/state.test.ts`
  - Acceptance: Tombstone ignores earlier checkpoints; overlapping compaction spans rejected; consumed checkpoints excluded; state rebuilds from a plain entry array (pi-independent).
  - Verify: `npx vitest run test/state.test.ts`
  - Files: src/state.ts, test/state.test.ts
  - Done: zero runtime imports (truly pi-independent); tombstone, overlap-rejection and native-compaction staleness all tested.
- [x] Task: Implement `src/settings.ts` (load/merge `~/.pi/agent/debloat.json` + `<project>/.pi/debloat.json` overrides, defaults: thinking `low`, lookback 100000) + `test/settings.test.ts`
  - Acceptance: Missing/corrupt files → defaults, no throw; project keys override global per-key; saves go to the layer being edited; round-trip works; unknown fields preserved.
  - Verify: `npx vitest run test/settings.test.ts`
  - Files: src/settings.ts, test/settings.test.ts
  - Done: 21 tests, temp dirs only. `/debloat settings` now uses the default-layer resolution (project when `<cwd>/.pi/` exists, else global) and names the file written.
- [x] Task: Implement `src/context-build.ts` (rebuild LLM message list from entries + state) + `test/context-build.test.ts`
  - Acceptance: Compacted spans replaced by single synthetic summary messages in correct order; newest span raw; native-compaction messages respected; fail-open returns original messages on internal error.
  - Verify: `npx vitest run test/context-build.test.ts`
  - Files: src/context-build.ts, test/context-build.test.ts
  - Done: injection is exactly `role: "user"`, `[Debloat summary <from>→<to>: <title>]`; `rebuildMessages` returns `null` on any index/message mismatch so `src/index.ts` fails open.
- [x] Task: Implement `src/llm.ts` (streamSimple one-shot wrapper, transcript formatting, JSON parse + one retry) + `test/llm.test.ts` (parsing only)
  - Acceptance: Valid/malformed/empty JSON handled per SPEC D3; thinking-level passed via options; usage captured.
  - Verify: `npx vitest run test/llm.test.ts`
  - Files: src/llm.ts, test/llm.test.ts
  - Done: JSON parse/validate/one-corrective-retry/transcript formatting are pi-free and tested. The actual provider call lives in `src/pi-glue.ts` (`createCaller`), inverted to `streamSimple` primary + `complete()` fallback so `reasoning` actually reaches the provider; fallback is pre-dispatch only (no double billing). Covered by `test/commands.test.ts`.
- [x] Task: Write `skills/find-checkpoint.md` and `skills/compact.md`
  - Acceptance: find-checkpoint defines boundary semantics + JSON output schema (`[{afterEntryId, label}]`) and cut-point rules; compact defines per-span title + structured summary format matching compacted-message injection prefix.
  - Verify: manual read-through against llm.ts prompt assembly
  - Files: skills/find-checkpoint.md, skills/compact.md
  - Done: both files already existed and were left untouched; their schemas are enforced in code by `validateCheckpoints` / `validateCompact` and read at runtime via `readSkillFile`. One residual wording mismatch is recorded in `tasks/contract.md` §Post-review amendments item 7.
- [x] Task: Implement commands: `src/commands/checkpoint-make.ts`, `src/commands/compact-checkpoint.ts`, `src/commands/debloat.ts` (settings dialogs, timeline render, remove-checkpoints confirm)
  - Acceptance: Behaviors match SPEC command table, including all notification/error paths (no checkpoints, empty window, LLM failure).
  - Verify: `npx tsc --noEmit`; manual smoke in `pi --extension ./src/index.ts`
  - Files: src/commands/*
  - Done: all documented notify/error paths implemented (no checkpoints, empty window, nothing to compact, LLM failure, unset model, cancel, settings file written, scanned span + usage totals, timeline status, tombstone confirm). Intent is pinned by the 22 stub-driven tests in `test/commands.test.ts`; `npx tsc --noEmit` clean. The interactive `pi --extension ./src/index.ts` smoke is folded into the last task (below).
- [x] Task: Implement `src/index.ts` extension entry + `package.json`
  - Acceptance: Registers 2 commands + `/debloat` with argument completions; `context` event wired with fail-open; `session_start` restores state from entries.
  - Verify: `npx tsc --noEmit`; extension loads in scratch pi session without errors
  - Files: src/index.ts, package.json
  - Done: registers `checkpoint-make`, `compact-checkpoint` and `debloat` (with `settings`/`timeline`/`remove-checkpoints` completions) plus `context` and `session_start`; `context` is total-fail-open (no throw, `event.messages` never mutated) and additionally survives pi trimming messages after a provider retry (fingerprint re-alignment, one warning per session). Load verified without a model call: `pi --offline --no-session -e ./src/index.ts --list-models` → exit 0, and pi's own `discoverAndLoadExtensions` → `errors: []`.
- [ ] Task: Manual end-to-end verification against SPEC success criteria 1–9 in a scratch session; fix findings
  - Acceptance: All 9 criteria demonstrably pass; vitest + tsc clean.
  - Verify: checklist walk in scratch session; `npx vitest run && npx tsc --noEmit`
  - Files: any fixes needed
  - Status: **NOT DONE — blocked on a live pi session with model auth.** Automated halves: 159 tests, tsc clean, and criteria 1–9 were re-scored against the current code by an independent verifier (none UNMET; 4 are static/unit-only for their user-visible half) with a real-`SessionManager` integration test proving criteria 5 and 8. Still to confirm by hand: real label/summary quality (criterion 1), the real retry-trim re-alignment path, a real post-compaction LLM request (criterion 5), and TUI rendering of the dialogs/timeline/notifies (criteria 2, 6, 7). Suggested walkthrough: `/debloat settings` → `/checkpoint-make` → `/compact-checkpoint` → `/debloat timeline` → `/debloat remove-checkpoints`.
- [x] Task: Add the D6 progress widget above the editor for `/checkpoint-make` and `/compact-checkpoint` (`src/progress.ts` + command wiring)
  - Acceptance: A single `debloat-progress` widget (animated `Loader` + elapsed seconds) is visible above the text input while a model call is in flight; `/checkpoint-make` shows `planning checkpoints — N message(s), ~T token(s)…`, `/compact-checkpoint` shows `compacting i/N — "from" → "to"` per span, and only phases that overlap an `await` are advertised (the row is first painted on the next render tick); the widget is cleared with `undefined` exactly once on every exit path (normal end, in-loop failure return, exception); `hasUI:false` makes no widget call and never throws; the commands no longer write `setStatus("debloat", …)` (owned by `index.ts`).
  - Verify: `npx vitest run`; `npx tsc --noEmit`
  - Files: src/progress.ts, src/commands/checkpoint-make.ts, src/commands/compact-checkpoint.ts, test/commands.test.ts, test/progress.test.ts, tasks/contract.md, SPEC.md
  - Done: implemented; `startProgress` is best-effort (hasUI-guarded, try/catch, never throws) and `stop()` clears the 1 s elapsed timer plus the Loader's animation timer in both `stop()` and `dispose()`. Both commands start the row immediately before the awaited model call and stop it in a `finally`, so it covers exactly the model call; `/checkpoint-make`'s earlier `reading context…` / `placing …` phases were removed after an independent review measured them unpaintable (pi defers the first render to the next tick). Row renders without a doubled blank line (pi adds its own spacer above widget rows). 5 command-level tests (in-flight render snapshots via a provider-stub `onStream` hook, exactly-once clear, no `debloat` setStatus, thrown/unusable span replies, `hasUI:false`) plus 9 direct `src/progress.ts` unit tests (suffix, lazy-factory update, double `stop()`, dispose-then-stop, timer baseline, no-op degradations). Suite 190 passed, tsc clean.
