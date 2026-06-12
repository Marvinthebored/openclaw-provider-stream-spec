# pioneer — provider stream catalogue

Status: draft (code-derived, no live capture) | Date: 2026-06-12 | Agent: Doc

## 1. Sources

- Docs: none found. No `docs/` page or plugin manifest for a "pioneer" provider
  exists in the read-only `~/openclaw` checkout.
- Code (read-only, `~/openclaw`, `git -c core.hooksPath=/dev/null`
  not needed — no writes):
  - `src/agents/openai-transport-stream.test.ts:1588-1627` — the only place
    "pioneer" appears as a *model* fixture: `provider: "pioneer-ai"`,
    `baseUrl: "https://api.pioneer.ai/v1"`, `api: "openai-completions"`,
    model id `claude-opus-4-8`, `reasoning: true`. This is a unit-test fixture
    for `parseTransportChunkUsage`, not a shipped catalog entry.
  - `src/plugins/runtime/load-context.test.ts`,
    `src/plugins/runtime/runtime-registry-loader.test.ts` — "pioneer" appears
    only as a **plugin id** (`plugins.entries.pioneer`) with `apiKey:
    "${PIONEER_API_KEY}"`, used to test env-var substitution in plugin config
    loading. No pioneer provider/runtime/auth code exists in `src/` or
    `extensions/` beyond these test fixtures.
  - `src/agents/openai-transport-stream.ts` — the streaming parser that would
    apply to any `api: "openai-completions"` model, including a
    hypothetically-configured pioneer model.
  - `src/agents/openai-completions-compat.ts`,
    `src/agents/provider-attribution.ts` — endpoint classification and
    thinking-format detection that determines how an unrecognized
    `baseUrl` (e.g. `api.pioneer.ai`) is treated.
- Captures: **none**. No `PIONEER_API_KEY` in env (not checked for/looked up,
  per instructions); a live capture is a follow-up once a key is exported.
  `captures/pioneer/capture.sh` is provided, parameterized on
  `$PIONEER_API_KEY`, ready to run when a key is available.

## 2. Frame inventory

Pioneer is **not a distinct wire dialect** in the codebase — it is referenced
only as (a) a plugin-config id with an API key placeholder, and (b) a one-off
test fixture asserting `api: "openai-completions"`. There is no
pioneer-specific frame parser, transport, or SSE wrapper anywhere in `src/` or
`extensions/`. Absent a pioneer-specific override, OpenClaw would apply its
generic **OpenAI Chat Completions streaming** parser
(`src/agents/openai-transport-stream.ts`, the `ChatCompletionChunk` /
`choice.delta` path used for `api: "openai-completions"`).

The frame inventory below is therefore the **OpenAI Chat Completions SSE
chunk shape that the OpenAI-completions transport parser expects**, annotated
with what it would do for a `pioneer/claude-opus-4-8`-style model. This is the
shape OpenClaw's embedded adapter would see on the wire if pioneer is, as its
test fixture implies, an OpenAI-Chat-Completions-compatible aggregator.

| Frame/event type | Key fields | Semantics | Source (docs § / capture file) |
|---|---|---|---|
| `chat.completion.chunk` (SSE `data:` line, JSON) | `id`, `choices[0].delta`, `choices[0].finish_reason`, `usage` (final chunk only, if `stream_options.include_usage`) | Standard OpenAI Chat Completions streaming chunk. `openai-transport-stream.ts:2900` casts each parsed SSE payload to `ChatCompletionChunk`. | `src/agents/openai-transport-stream.ts:2893-2935` (code-derived; no capture) |
| `choices[0].delta.content` (string or array) | text and/or structured content parts | Visible assistant text. Parsed via `getCompletionsContentDeltas` (array form) — each part classified as `text`/`output_text` (→ text) or a `thinking`/`reasoning`-typed part (→ thinking), per `openai-transport-stream.ts:3300-3308`. | code-derived |
| `choices[0].delta.reasoning_content` / `.reasoning` / `.reasoning_text` (string, first-match-wins) | reasoning/thinking text | Provider "thinking" lane carried as a sibling string field on the delta (DeepSeek/OpenRouter-style convention), **not** as an Anthropic-style `thinking` content block. `getCompletionsReasoningDeltas` (`openai-transport-stream.ts:3311-3362`) checks `reasoning_details[]` array first (`type: "reasoning.text"`), then falls back to these three flat string fields, first non-empty wins. Matches the prior fact "pioneer returns thinking + text keys" — i.e. a JSON object with sibling `thinking`/`reasoning_*` and `content`/`text` keys per chunk. | code-derived; **field name pioneer actually uses (`reasoning_content` vs `reasoning` vs `reasoning_text` vs `reasoning_details`) is unverified** |
| `choices[0].delta.tool_calls[]` | `index`, `id`, `function.name`, `function.arguments` (incremental JSON string) | Standard OpenAI streaming tool-call delta, accumulated by index/id into `toolCallBlocksByIndex`/`toolCallBlocksById`. | code-derived |
| `choices[0].finish_reason` | `"stop" \| "tool_calls" \| "length" \| ...` | Mapped via `mapStopReason`; `"stop"` sets `sawStopFinishReason`. | code-derived |
| `usage` (top-level on final chunk, or `choices[0].usage`) | `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`, `prompt_tokens_details.cache_write_tokens`, `completion_tokens_details.reasoning_tokens` | Parsed via `parseTransportChunkUsage` (tested directly against the `pioneer-ai`/`claude-opus-4-8` fixture in `openai-transport-stream.test.ts:1588-1627`, confirming cache-write and reasoning-token usage mapping work for this model shape). | `src/agents/openai-transport-stream.test.ts:1602-1627` |
| SSE terminator `data: [DONE]` | n/a | Standard OpenAI Chat Completions stream end marker. | code-derived (OpenAI Chat Completions convention; not pioneer-specific code) |

No system/init, rate_limit, or result-wrapper frames analogous to claude-cli's
dialect are expected — Chat Completions streams are flat SSE `chat.completion.chunk`
events with no outer envelope.

## 3. Content lanes

- **Final answer text**: `choices[0].delta.content` (string) or, for structured
  content arrays, parts classified as `text`/`output_text` by
  `getCompletionsContentDeltas`. Accumulated across chunks into the final
  assistant message text.
- **Thinking/reasoning**: carried as sibling fields on the delta object
  (`reasoning_content`/`reasoning`/`reasoning_text`, or `reasoning_details[]`
  with `type: "reasoning.text"`), **not** as Anthropic-style `content_block`
  thinking blocks. `getCompletionsReasoningDeltas` converts these into
  `{ kind: "thinking", signature: <field-name>, text }` internal deltas, which
  `appendThinkingDelta` turns into `thinking` content blocks
  (`thinking_start`/`thinking_delta`/`thinking_end` stream events) — **only if
  `emitReasoning` is true** for the model/config.
- **Narration/commentary/preamble**: Chat Completions has no separate
  narration channel; any interim text arrives as ordinary `delta.content`
  chunks before/after tool calls, same lane as final answer text. The
  `reasoningTagTextPartitioner` (`createReasoningTagTextPartitioner`) exists to
  split inline `<think>`-tag-style reasoning out of visible text for providers
  that embed reasoning in the content stream rather than a sibling field.
- **Tool calls + results**: `choices[0].delta.tool_calls[]`, standard OpenAI
  incremental function-call delta format (index/id + `function.name` +
  streamed `function.arguments` JSON string fragments).
- **Usage/metadata**: `usage` object (prompt/completion/total tokens, cache
  read/write breakdown via `prompt_tokens_details`, reasoning-token count via
  `completion_tokens_details.reasoning_tokens`). Confirmed by test
  `"maps OpenAI-compatible cache-write usage fields"` against the exact
  `pioneer-ai`/`claude-opus-4-8` model shape — `prompt_tokens_details:
  {cached_tokens, cache_write_tokens}` → `{cacheRead, cacheWrite}`, plus cost
  computed from `model.cost`.
- **Errors**: not specifically tested for pioneer; generic OpenAI-completions
  error handling (HTTP error responses, `finish_reason` mapping with
  `errorMessage` in `mapStopReason`) would apply.

## 4. Ordering & interleaving guarantees

Standard Chat Completions ordering: chunks arrive in emission order over a
single SSE stream, one `choices[0]` per chunk (no parallel-choice handling in
this code path — `chunk.choices[0]` only). `delta.tool_calls[].index` is the
stable per-call index used to accumulate argument fragments across chunks.
Text/thinking/tool-call content can interleave within a single response:
the parser tracks `currentBlock` and finalizes the current block
(`finishCurrentBlock`) when switching between text, thinking, and tool-call
content, queuing any reasoning deltas that arrive *during* a tool call
(`queuePostToolCallDelta`) for replay afterward. No `index`/`seq` field is
provided by the wire format itself beyond `tool_calls[].index`; ordering is
purely stream-arrival order.

## 5. Delta vs snapshot semantics

Everything is **incremental** — `delta.content`, `delta.reasoning_content`
(etc.), and `delta.tool_calls[].function.arguments` are all fragments to be
concatenated. The only snapshot-like fields are `usage` (final-chunk
cumulative totals, not deltas) and `finish_reason` (set once, on the final
chunk for that choice). There is no full-message-snapshot frame analogous to
claude-cli's `assistant` frame — Chat Completions never re-sends the
accumulated message; the consumer must build it from deltas.

## 6. Termination & final-frame semantics

A turn ends when a chunk's `choices[0].finish_reason` is non-null
(`"stop"`, `"tool_calls"`, `"length"`, etc.), optionally followed by one more
chunk carrying only `usage` (if `stream_options: {include_usage: true}` was
requested and the endpoint supports `supportsUsageInStreaming` — see §7), then
the SSE stream closes (`data: [DONE]` for true OpenAI; aggregators vary). The
final answer is the concatenation of all `text`-classified content deltas up
to the `finish_reason` chunk. There is no separate "result" frame; the final
answer is implicit in the accumulated stream, mirroring the contract's
"Non-streaming provider with one final response" row only in the sense that
there's a single logical response — but pioneer *does* stream incremental
progress per this analysis, so it should map like OpenAI/Codex streamed output
(`assistant` commentary/delta), not the non-streaming fallback row.

## 7. Observed dialect deviations

All of the following are **derived from generic OpenAI-completions compat
code, not pioneer-specific code** — no pioneer branch exists anywhere:

- `detectOpenAICompletionsCompat` (`src/agents/openai-completions-compat.ts:147`)
  calls `resolveProviderEndpoint(baseUrl)`
  (`src/agents/provider-attribution.ts:421-440`). For `baseUrl:
  "https://api.pioneer.ai/v1"`, the hostname `api.pioneer.ai` matches none of
  the recognized native-endpoint patterns, so
  `endpointClass = "custom"` (the final fallback at
  `provider-attribution.ts:440`).
- With `endpointClass: "custom"`: `usesConfiguredBaseUrl = true`,
  `usesKnownNativeOpenAIEndpoint = false`, so
  `usesExplicitProxyLikeEndpoint = true`, and `usesConfiguredNonOpenAIEndpoint
  = true` in `resolveOpenAICompletionsCompatDefaults`.
- `isNonStandard` is **false** for `endpointClass: "custom"` (the
  `isNonStandard` list covers `cerebras-native`, `chutes-native`,
  `deepseek-native`, `mistral-public`, `opencode-native`, `xai-native`, plus
  zai/xiaomi by provider id — "custom" is not in that list).
  `isOpenRouterLike` is false (`provider !== "openrouter"` and
  `endpointClass !== "openrouter"`).
  → **`thinkingFormat` resolves to the final fallback `"openai"`** (not
  `"deepseek"`/`"zai"`/`"together"`/`"openrouter"`).
- Practical effect of `thinkingFormat: "openai"` plus `reasoning: true`:
  `getCompletionsReasoningDeltas` still applies its field-probing logic
  (`reasoning_details[]` → `reasoning_content`/`reasoning`/`reasoning_text`)
  regardless of `thinkingFormat`, since that probing is in the shared
  `getCompletionsReasoningDeltas` function, not gated by `thinkingFormat`.
  `thinkingFormat` instead affects `requiresReasoningContentOnAssistantMessages`
  (false here) and replay/round-trip behavior for assistant messages containing
  prior reasoning (`shouldPreserveOpenRouterReasoningReplay`, `thinkingFormat
  === "deepseek" || "zai"` branches — none apply to "custom"/"openai").
- `supportsDeveloperRole = false` (uses `system` role instead of `developer`)
  because `usesConfiguredNonOpenAIEndpoint = true`.
- `supportsStrictMode = !isZai && !usesConfiguredNonOpenAIEndpoint` → **false**
  for pioneer (custom endpoint).
- `supportsUsageInStreaming`: depends on
  `supportsOpenAICompletionsStreamingUsageCompat ||
  (!isNonStandard && (isLocalEndpoint || !usesConfiguredNonOpenAIEndpoint ||
  supportsNativeStreamingUsageCompat))`. For pioneer: `isNonStandard=false`,
  `isLocalEndpoint=false`, `usesConfiguredNonOpenAIEndpoint=true`, so this
  reduces to whether `supportsNativeStreamingUsageCompat` or
  `supportsOpenAICompletionsStreamingUsageCompat` is set — **neither is set by
  default for an unrecognized provider**, so usage-in-streaming is likely
  **off by default** unless pioneer's manifest/model config sets one of those
  compat flags explicitly (none found).
- **"opus-via-pioneer emits no thinking_delta stream events"** (prior fact):
  consistent with the above IF pioneer's wire format puts reasoning text in
  `reasoning_content`/`reasoning`/`reasoning_text` but the *specific*
  `claude-opus-4-8` route either (a) never populates those fields (model
  doesn't stream reasoning), or (b) `emitReasoning` is false for that model/
  config so `appendThinkingDelta` is never called even when
  `getCompletionsReasoningDeltas` returns a `thinking`-kind delta
  (`openai-transport-stream.ts:2963-2964`: `if (reasoningDelta.kind ===
  "thinking" && !emitReasoning) continue;`). Either explanation is consistent
  with code but **neither is confirmed** without a live capture.

## 8. Proposed normalization

Mapping the OpenAI-completions-parser frames (§2) — as they would apply to a
`pioneer/claude-opus-4-8` route — to OpenClaw streams per
`reference/agent-event-io-contract-f92c1bf.md` §"Provider input contract" /
§"Provider mapping guide". This table is total over §2.

| Frame (delta field) | OpenClaw stream | data shape |
|---|---|---|
| `choices[0].delta.content` (text-classified) | `assistant`, `data.delta` (or `data.text` if reassembled) | per contract row "OpenAI/Codex delta frame with no full text → `stream: "assistant"`, `data.delta`; do not drop because `text` is missing." `phase` omitted unless a terminal signal marks final. |
| `choices[0].delta.reasoning_content` / `.reasoning` / `.reasoning_text` / `reasoning_details[type="reasoning.text"]` | `thinking` (or dropped) | per contract row "Claude/Anthropic thinking/reasoning → `stream: "thinking"` or drop, unless explicitly configured for reasoning display." Gated by `emitReasoning` in the current adapter — when false, these deltas are silently discarded today (matches the "opus-via-pioneer emits no thinking_delta" observation if `emitReasoning` is false for that route). |
| `choices[0].delta.tool_calls[]` (first chunk for a given index/id) | `item`/`tool`, phase `"start"`, status `"running"` | per "Function/tool call begin" row. |
| `choices[0].delta.tool_calls[]` (subsequent chunks, same index/id) | `item`/`tool`, phase `"update"` | argument-fragment accumulation; not independently user-visible. |
| `choices[0].finish_reason` set (`"tool_calls"`) | `item`/`tool`, phase `"end"`, status `"completed"`/`"failed"` | per "Function/tool call result" row, once the tool's result is available from the runtime (Chat Completions itself doesn't carry tool *results* — those come back as a follow-up request's `role: "tool"` message, outside this stream). |
| `choices[0].finish_reason` set (`"stop"`) | `assistant data.phase: "final_answer"` (final reply path) + `lifecycle` end | per "OpenAI/Codex final output text" row. |
| `usage` (final chunk) | `lifecycle` (usage metadata) | cost/usage accounting, not assistant-visible content. |
| SSE `[DONE]` / stream close | `lifecycle` (end) | terminal signal; "lifecycle end is not itself a final answer" — final answer text comes from the accumulated `delta.content`. |
| HTTP/stream error (any point) | `lifecycle` (error) | per contract; `mapStopReason`'s `errorMessage` would feed this. |

### Caveat on this mapping

This table assumes pioneer is a **bare OpenAI Chat Completions** aggregator
with no custom envelope. If pioneer instead wraps responses in its own outer
JSON (the way claude-cli wraps Anthropic SSE in `stream_event`), this entire
§2-§8 would need revision once a live capture exists. **No evidence either
way was found in code** — the only pioneer-specific artifact is the
`api: "openai-completions"` + custom `baseUrl` declaration in a test fixture,
which only proves the *intended* family, not a verified wire capture.

## 9. Open questions

- **No pioneer provider/plugin implementation exists in this checkout.**
  `plugins.entries.pioneer` appears only in two runtime-loader test fixtures
  testing `${PIONEER_API_KEY}` substitution generically — there is no
  `extensions/pioneer/` directory, manifest, or catalog entry. Where is the
  real pioneer provider/model catalog declared (a different repo, a remote
  catalog fetched at runtime, or local-only `openclaw.json` config on this
  machine)? This catalogue cannot confirm base URL, auth header shape, or
  model-id routing beyond the single test fixture's literal values
  (`https://api.pioneer.ai/v1`, `claude-opus-4-8`, `pioneer-ai` as the
  `provider` field — note this differs from the `modelProvider: "pioneer"`
  naming in the task, suggesting `pioneer-ai` may be an internal/test alias
  rather than the production provider id).
- **Exact reasoning field name pioneer uses is unverified**: `reasoning_content`
  vs `reasoning` vs `reasoning_text` vs `reasoning_details[]` — all four are
  handled by `getCompletionsReasoningDeltas`, first-match-wins in that order
  (`reasoning_details` checked first, then the three flat fields in listed
  order). "pioneer returns thinking + text keys" (prior fact) is consistent
  with any of these but doesn't pin down which.
- **`emitReasoning` gating**: is `emitReasoning` true or false for
  `pioneer/claude-opus-4-8` in current OpenClaw model config/manifest? This
  single flag determines whether the "opus-via-pioneer emits no thinking_delta"
  observation is a wire-format fact (pioneer never sends reasoning fields for
  this model) or a config fact (OpenClaw drops them before emission). Could
  not be checked without finding the pioneer model manifest/config (not present
  in `src/`/`extensions/`).
- **`supportsUsageInStreaming` / `stream_options.include_usage`**: unverified
  whether OpenClaw's pioneer route requests `include_usage` and whether pioneer
  honors it — affects whether `usage`/cost data arrives mid-stream or only via
  a non-streaming follow-up.
- **Outer envelope**: confirm pioneer emits bare `chat.completion.chunk` SSE
  with no wrapper (as assumed in §2-§8) versus some aggregator-specific
  wrapping — only a live capture via `captures/pioneer/capture.sh` (once
  `$PIONEER_API_KEY` is exported by Peter) can resolve this.
- **Anthropic-compatible alternative**: the task names the model
  `pioneer/claude-opus-4-8` (an Anthropic model id) routed through an
  aggregator — confirm pioneer doesn't *also* offer an `anthropic-messages`-
  compatible endpoint that OpenClaw could prefer instead of
  `openai-completions` (the test fixture only proves the latter is
  *supported*, not that it's the *only or primary* route OpenClaw uses).

## 10. Capture confirmation (2026-06-12, live)

- **Envelope CONFIRMED bare CC SSE** — `captures/pioneer/stream.jsonl` /
  `stream-thinking.jsonl`: standard `chat.completion.chunk` frames, no wrapper.
  §2-§8 mapping stands as written. Open question "outer envelope" RESOLVED.
- **Opus via pioneer: NO reasoning sibling fields observed** — both captures carry
  `delta.content` only, even on a think-style prompt. Consistent with the wire-level
  explanation (Anthropic thinking doesn't round-trip through CC format), though
  thinking-not-triggered cannot be fully excluded from 2 samples.
- **Key is model-scoped**: `/v1/models` returns `invalid_credentials` under both
  Authorization-Bearer and x-api-key; a `deepseek-r1` chat attempt also returns
  `invalid_credentials` while `claude-opus-4-8` succeeds. This install's pioneer
  entitlement is Claude-family only (matches the openclaw allowlist:
  pioneer/claude-{haiku-4-5,opus-4-6,opus-4-8,sonnet-4-6}). deepseek-dialect goldens
  come from deepseek-direct and OpenRouter instead.
