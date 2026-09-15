# Plan: Debloat implementation

> Implements [SPEC.md](../SPEC.md). Order is dependency-driven; each phase ends in a verification checkpoint.

## Component dependency graph

```
settings.ts ──┐
ranges.ts ────┼──► state.ts ──► context-build.ts ──► commands/* ──► index.ts
              └──► llm.ts ────────────────────────────┘
skills/*.md (prompt files, read at call time)
```

- `ranges.ts` and `state.ts` are pure — build and test them first.
- `context-build.ts` consumes state; it is the correctness-critical piece (LLM-visible output).
- `llm.ts` is thin glue over `streamSimple`; needs a live model to verify, so unit-test only its parsing layer.
- Commands and `index.ts` are wiring; verify manually in a scratch pi session.

## Implementation order

1. **Foundations (pure logic):** `ranges.ts`, `state.ts`, `settings.ts` + unit tests.
2. **Context rebuild:** `context-build.ts` + unit tests (verify against SPEC success criteria 5, 7, 8).
3. **LLM layer:** `llm.ts` + parsing tests; write `skills/find-checkpoint.md` and `skills/compact.md` with JSON output schemas.
4. **Commands:** `checkpoint-make`, `compact-checkpoint`, `debloat` (settings/timeline/remove-checkpoints).
5. **Entry point:** `index.ts` wiring (commands, `context` event, `session_start` state restore), `package.json`.
6. **Manual end-to-end verification** in a scratch session against all SPEC success criteria.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `context` event message list may not map 1:1 to branch entries | Rebuild the message list from `sessionManager` entries rather than editing `event.messages` in place; fall back to `event.messages` untouched if rebuild fails (fail-open = current pi behavior). |
| LLM returns malformed JSON or impossible boundary ids | Strict schema validation + one corrective retry, then notify failure without mutating session state. |
| Boundary lands mid-tool-pair (between toolCall and toolResult) | Cut-point validation in `ranges.ts` rejects; retry prompt includes the rule. |
| Native auto-compaction interleaves with debloat spans | Staleness rule (D2): checkpoints before native cut point become consumed; span math only ever considers active checkpoints. |
| `streamSimple` option shapes differ per provider API | Keep `llm.ts` isolated; verify thinking-level pass-through per provider during task 3 with the user's configured models; degrade to model default thinking if unsupported. |
| Checkpoint entries appended at leaf but logically "inside" history confuses pi's tree | Checkpoints are non-message custom entries — invisible to LLM and to pi's compaction; only Debloat's derived state uses `afterEntryId`. |

## Parallelizable

Tasks 1a (ranges), 1b (state), 1c (settings) are independent. Task 3 skill files can be drafted while task 2 is in progress. Everything else is sequential.

## Verification checkpoints

- After phase 1: `npx vitest run` green on pure logic.
- After phase 2: context-build tests demonstrate exact `[summary][summary][raw]` output shape.
- After phase 5: `npx tsc --noEmit` clean, extension loads with `pi --extension ./src/index.ts`.
- Final: manual walk of SPEC success criteria 1–9 in a scratch session.
