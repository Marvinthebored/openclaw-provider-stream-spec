# Conformance Results

Legend: `P` = pass; `TODO` = adapter stubbed/not run. Results below come from
`node tools/bootstrap.ts` plus a direct replay-vs-fixture smoke over all implemented
goldens. `pnpm test` could not execute in this sandbox because `vitest`/`tsx` could not
be installed from the blocked npm registry.

| Capture | Adapter | I1 | I2 | I3 | I4 | I5 | I6 | I7 | I8 | I9 | I10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `anthropic/01-text-stream.sse` | F1 | P | P | P | P | P | P | P | P | P | P |
| `anthropic/02-thinking-stream.sse` | F1 | P | P | P | P | P | P | P | P | P | P |
| `anthropic/03-tool-use-stream.sse` | F1 | P | P | P | P | P | P | P | P | P | P |
| `claude-cli/plain.jsonl` | F1e | P | P | P | P | P | P | P | P | P | P |
| `claude-cli/reasoning.jsonl` | F1e | P | P | P | P | P | P | P | P | P | P |
| `pioneer/stream.jsonl` | F2 | P | P | P | P | P | P | P | P | P | P |
| `pioneer/stream-thinking.jsonl` | F2 | P | P | P | P | P | P | P | P | P | P |
| `openrouter/claude-sonnet.sse` | F2 | P | P | P | P | P | P | P | P | P | P |
| `openrouter/deepseek-r1.sse` | F2 | P | P | P | P | P | P | P | P | P | P |
| `openrouter/gpt-5-mini.sse` | F2 | P | P | P | P | P | P | P | P | P | P |
| `deepseek/deepseek-reasoner.sse` | F2 | P | P | P | P | P | P | P | P | P | P |
| `moonshot/kimi-k2.6.sse` | F2 | P | P | P | P | P | P | P | P | P | P |
| `moonshot/moonshot-v1-8k.sse` | F2 | P | P | P | P | P | P | P | P | P | P |
| `gpt-oss/openai-compat.sse` | F2 | P | P | P | P | P | P | P | P | P | P |
| `gpt-oss/openai-compat-tools.sse` | F2 | P | P | P | P | P | P | P | P | P | P |
| `gpt-oss/compat-preamble.sse` | F2 | P | P | P | P | P | P | P | P | P | P |
| `openai/cc-tool-call.sse` | F2 | P | P | P | P | P | P | P | P | P | P |
| `openai/responses-reasoning.sse` | F3 | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| `openai/responses-reasoning-o4-mini.sse` | F3 | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| `gemini/gemini-2.5-flash-thinking.sse` | F5 | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| `gemini/gemini-2.5-flash-thinking-long.sse` | F5 | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| `gemini/gemini-2.5-flash-tool-thinking.sse` | F5 | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO |

## Invariant Key

- I1: `seq` strictly increases; event order follows frame order.
- I2: no signature/encrypted material leaks into normalized events.
- I3: at most one `final_answer`; none on reject/suspend/dead/tool-yield paths.
- I4: `final_answer` replacement key is present by provider id or `seq`.
- I5: thinking variants are valid; redacted markers are content-free.
- I6: every input frame is accounted for as event, transcript, drop, or diagnostic.
- I7: exactly one terminal lifecycle event.
- I8: `truncated:true` appears iff the dispatch path is Truncate.
- I9: null/empty content does not produce empty assistant text events.
- I10: F2 dialect quirks are honored, including optional `[DONE]` and usage probing.

## Side-Channel Checks

- F1 `signature_delta` is recorded in adapter transcript and absent from events.
- F1e Claude CLI snapshot signatures are recorded in adapter transcript and absent from events.
- OpenRouter `reasoning_details[].signature` and `reasoning.encrypted.data` are recorded in adapter transcript and absent from events.
- F2 usage probing covers top-level, `choices[0].usage`, and `choices[0].delta.usage` locations; the third is covered by a synthetic unit in the vitest file because the current Moonshot captures place usage at `choices[0].usage`.
