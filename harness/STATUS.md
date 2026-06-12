# Status

Implemented:

- Harness package with npm, Vitest, direct-Node bootstrap, normalized event types, replay parser, adapter accounting, invariant checks, fixture generator, and conformance tests.
- F1 Anthropic SSE adapter: text, raw/redacted thinking, signature transcript, tool-use items, usage/thinking-token backfill, finality dispatch.
- F1e Claude CLI envelope: system/status/rate-limit diagnostics, inner F1 progress, snapshot signature transcript, `result.result` as the single final-answer source.
- F2 Chat Completions adapter: flat and structured reasoning, structured-wins dedup, OpenRouter signatures/encrypted transcript, null-content handling, tool calls, optional `[DONE]`, all documented usage locations, and section 3.5 dispatch.
- F3 OpenAI Responses adapter: lifecycle start/update/drop handling, output text/refusal segments keyed as `item_id:content_index`, reasoning raw/summary/redacted lanes, encrypted reasoning transcript, function-call items, completed/failed/incomplete dispatch, usage/thinking-token backfill, and stream-closed synthesis.
- F5 Gemini GenAI SSE adapter: `thought:true` parts as thinking `summary`, `thoughtSignature` transcript side-channel, function-call item start/end, cumulative `usageMetadata`, finishReason dispatch for STOP/MAX_TOKENS/SAFETY/RECITATION/OTHER/MALFORMED_FUNCTION_CALL, and stream-closed synthesis.
- Ollama-native `/api/chat` envelope adapter for gpt-oss captures: `message.thinking` raw thinking, `message.content` final text, object-form `tool_calls[].function.arguments`, native usage/perf stats, and tool-use terminal dispatch.
- Expected fixtures generated for all 26 implemented goldens.

Verification:

- `npm install` passes.
- `npm run bootstrap` passes and regenerates all expected fixtures. The bootstrap script uses `node tools/bootstrap.ts` because `tsx` cannot open its IPC pipe in this sandbox.
- `npx vitest run` passes: 1 test file, 35 tests.
