# Status

Implemented:

- Harness package with `pnpm`, `vitest`, and `tsx` scripts; no runtime/OpenClaw deps.
- Normalized event types, replay parser, adapter accounting, invariant checks, bootstrap fixture generator, and vitest tests.
- F1 Anthropic SSE adapter: text, raw/redacted thinking, signature transcript, tool-use items, usage/thinking-token backfill, finality dispatch.
- F1e Claude CLI envelope: system/status/rate-limit diagnostics, inner F1 progress, snapshot signature transcript, `result.result` as the single final-answer source.
- F2 Chat Completions adapter: flat and structured reasoning, structured-wins dedup, OpenRouter signatures/encrypted transcript, null-content handling, tool calls, optional `[DONE]`, all documented usage locations, and section 3.5 dispatch.
- Expected fixtures generated for 17 implemented F1/F1e/F2 goldens.

Stubbed:

- F3 Responses adapter: TODO stub emits unsupported-frame diagnostics plus terminal error.
- F5 Gemini adapter: TODO stub emits unsupported-frame diagnostics plus terminal error.

Verification:

- `node tools/bootstrap.ts` passes and regenerates all implemented fixtures.
- Direct Node replay-vs-fixture smoke passes for all 17 implemented goldens.
- `pnpm install`, `pnpm bootstrap`, and `pnpm test` are blocked in this sandbox by `EPERM` registry fetch failures for `vitest`/`tsx` dependencies, so the vitest runner itself could not be executed here.
