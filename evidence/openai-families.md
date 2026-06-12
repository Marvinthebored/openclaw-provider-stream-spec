# OpenAI streaming wire families — provider stream catalogue

Status: draft | Date: 2026-06-12 | Agent: claude (sub-agent, provider-content-pipeline research)

This document covers **three** related OpenAI wire families:

- Family A — Chat Completions SSE (`/v1/chat/completions`, `stream: true`)
- Family B — Responses API streaming (`/v1/responses`, `stream: true`)
- Family C — Harmony channel format (gpt-oss / open-weight models)

Each family repeats template §2–§8.

## 1. Sources

- Docs: `platform.openai.com/docs/api-reference/chat-streaming` and
  `platform.openai.com/docs/api-reference/responses-streaming` (accessed 2026-06-12; both
  returned HTTP 403 to automated fetch — content reconstructed from the canonical
  `openai-python` SDK type definitions on GitHub, which mirror the documented wire schema
  field-for-field).
- `github.com/openai/openai-python` — `src/openai/types/chat/chat_completion_chunk.py`,
  `src/openai/types/responses/response_stream_event.py` and per-event files
  (`response_output_item_added_event.py`, `response_text_delta_event.py`,
  `response_function_call_arguments_delta_event.py`, `response_reasoning_item.py`,
  `response_completed_event.py`, `response_content_part_added_event.py`,
  `response_error_event.py`, `response_usage.py`) — accessed 2026-06-12.
- `developers.openai.com/cookbook/articles/openai-harmony` and
  `developers.openai.com/cookbook/articles/gpt-oss/handle-raw-cot` (accessed 2026-06-12).
- `github.com/openai/harmony` — README/format overview (accessed 2026-06-12).
- Captures: `captures/openai/capture.sh` writes `captures/openai/cc-tool-call.sse` (family A)
  and `captures/openai/responses-reasoning.sse` (family B).
  **Capture blocked: no OPENAI_API_KEY in env** — verified via
  `[ -n "$OPENAI_API_KEY" ]` (returned "KEY NOT SET"). The script is ready to run once a key
  is exported; it never echoes the key or any auth header. No captures exist yet for any of
  the three families, so all rows below are sourced from docs/SDK types only.

---

# Family A — Chat Completions SSE

## A.2 Frame inventory

| Frame/event type | Key fields | Semantics | Source (docs § / capture file) |
|---|---|---|---|
| `chat.completion.chunk` (every SSE `data:` line until `[DONE]`) | `id`, `object: "chat.completion.chunk"`, `created`, `model`, `service_tier`, `system_fingerprint`, `choices[]`, `usage` (null until final usage chunk) | The single frame type for this family. Every SSE event is one JSON object of this shape; differences are in which sub-fields of `choices[].delta` are populated. | chat-streaming docs / openai-python `chat_completion_chunk.py` |
| `choices[].delta.role` | `role: "assistant"` (first chunk only) | Announces the assistant turn is starting; appears once, typically in the first chunk with empty/absent content. | SDK `ChoiceDelta.role` |
| `choices[].delta.content` | `content: string \| null` | Incremental text delta for the assistant's visible message content. Concatenate across chunks to reassemble the full message. | SDK `ChoiceDelta.content` |
| `choices[].delta.refusal` | `refusal: string \| null` | Incremental text delta for a model-generated refusal message, carried in a separate lane from `content`. | SDK `ChoiceDelta.refusal` |
| `choices[].delta.tool_calls[]` | `index: int`, `id?: string`, `type?: "function"`, `function.name?: string`, `function.arguments?: string` | Incremental tool-call construction. `index` identifies which parallel tool call a delta belongs to; `id`/`type`/`function.name` typically arrive in the first delta for that index, and `function.arguments` arrives as a string fragment to be concatenated per-index until the call's JSON argument blob is complete. | SDK `ChoiceDeltaToolCall`, `ChoiceDeltaToolCallFunction` |
| `choices[].finish_reason` | `finish_reason: "stop" \| "length" \| "tool_calls" \| "content_filter" \| "function_call" \| null` | Null on every chunk except the last one for that choice; signals why generation stopped. `"tool_calls"` means the model finished emitting one or more complete tool calls and is yielding control back to the caller. | SDK `Choice.finish_reason` |
| `choices[].logprobs` | `ChoiceLogprobs \| null` | Optional per-token log-probability data when `logprobs: true` requested. | SDK `Choice.logprobs` |
| usage chunk | top-level `usage: CompletionUsage` (`prompt_tokens`, `completion_tokens`, `total_tokens`, plus `*_tokens_details`); `choices: []` (empty array) | Final extra chunk emitted only when the request sets `stream_options: {"include_usage": true}`. Arrives **after** the chunk carrying `finish_reason`, with an empty `choices` array and populated `usage`. | chat-streaming docs / SDK `CompletionUsage` |
| `[DONE]` sentinel | literal SSE payload `data: [DONE]` (not JSON) | Terminal sentinel for the SSE stream. Always the last event; signals the consumer to stop reading and close the connection. | chat-streaming docs |

## A.3 Content lanes

- **Final answer text**: `choices[].delta.content` deltas, concatenated. There is exactly one
  text lane — Chat Completions has no concept of "interim" vs "final" segments within a
  single assistant turn; everything in `delta.content` is the assistant's message.
- **Thinking/reasoning**: **Not supported.** Chat Completions has **no native reasoning lane**.
  Reasoning models accessed via this endpoint (e.g. `o-series` via CC compatibility mode) do
  not expose chain-of-thought, reasoning summaries, or encrypted reasoning blobs in this wire
  format — only `content`, `refusal`, and `tool_calls` deltas exist. Any reasoning the model
  performs is opaque to the caller.
- **Narration/commentary/preamble**: Not a distinct lane. If a model emits prose before/around
  tool calls, it arrives as ordinary `delta.content` text interleaved (by chunk order) with
  `delta.tool_calls` deltas in the same `choices[]` stream — there is no field that marks it as
  "commentary" vs "final".
- **Tool calls + results**: Tool calls are constructed incrementally via `delta.tool_calls[]`
  (see A.2). Tool **results** are not part of this stream at all — the caller executes the
  tool and sends the result back as a new `role: "tool"` message in a subsequent request; CC
  streaming carries only the call construction, never the result.
- **Usage/metadata**: `usage` is `null` on all normal chunks and populated only on the final
  usage-only chunk when `stream_options.include_usage: true` is set. Without that option, no
  usage data is ever streamed.
- **Errors**: Not a typed frame in this family. Mid-stream errors surface as an HTTP-level
  error (non-200 status before streaming starts) or an abrupt connection close; there is no
  documented in-band `error` SSE event analogous to the Responses API's `error` event.

## A.4 Ordering & interleaving guarantees

- Chunks arrive in generation order; `choices[].index` identifies which choice (for `n > 1`)
  a delta belongs to — chunks for different choices can interleave.
- Within a single choice, `delta.content` text and `delta.tool_calls` deltas can interleave at
  the chunk level: a model may emit some `content` text, then start a tool call, then continue
  emitting `content` after — there is no structural boundary marker between these other than
  chunk sequence.
- `delta.tool_calls[].index` is the only ordering key for reconstructing multiple parallel tool
  calls; deltas for different `index` values can interleave across chunks, but each call's
  `function.arguments` fragments arrive in-order for that index.
- `finish_reason` is non-null only on the last chunk for a given choice; the optional usage
  chunk (empty `choices`) comes after that, and `[DONE]` is always absolute-last.
- No explicit `seq`/`sequence_number` field exists in this family — ordering is purely
  stream/transport order (SSE delivery order = generation order).

## A.5 Delta vs snapshot semantics

- Every populated field in `choices[].delta` is an **incremental delta**, not a snapshot.
  `content`, `refusal`, and `tool_calls[].function.arguments` must all be concatenated
  (string append) per their respective keys (message-level for content/refusal, per
  `tool_calls[].index` for arguments) to reconstruct the final values.
- `tool_calls[].id`, `type`, and `function.name` are typically sent once (in the first delta
  for that index) and not repeated — treat as "set on first sight, then immutable" rather than
  deltas.
- The top-level `usage` chunk is a full snapshot of total usage for the whole request — not
  incremental, and not repeated.
- There is no full-response "snapshot" frame anywhere in this family; the only way to get the
  complete object is client-side reassembly of all deltas.

## A.6 Termination & final-frame semantics

- The turn ends when a chunk's `choices[0].finish_reason` is non-null. Common values:
  - `"stop"` — natural end of assistant turn (final answer complete).
  - `"tool_calls"` — model finished emitting one or more tool calls; caller should execute them
    and continue the conversation.
  - `"length"` — truncated due to `max_tokens`.
  - `"content_filter"` — truncated/blocked by content filtering.
  - `"function_call"` — legacy single-function-call equivalent of `"tool_calls"`.
- If `stream_options.include_usage: true`, one more chunk follows with `choices: []` and
  populated `usage`, then `data: [DONE]`.
- If usage was not requested, the chunk with `finish_reason` set is immediately followed by
  `data: [DONE]`.
- There is no separate "final answer" marker distinct from "all the `content` deltas
  concatenated up to the `finish_reason` chunk" — the entire accumulated `content` string for
  that choice **is** the final answer (CC has no commentary/final split).

## A.7 Observed dialect deviations

Verified against `captures/openai/cc-tool-call.sse` (gpt-4.1-mini, tool call, 2026-06-12):

- **`delta.role` — CONFIRMED, first chunk only, co-present with `tool_calls`.**
  Chunk 1: `"delta":{"role":"assistant","content":null,"tool_calls":[{...}],"refusal":null}`.
  `role` appears in the same chunk that opens the first tool-call delta, not in a content-only
  preamble chunk. The docs-derived note about "typically first chunk with empty content" was
  imprecise — role and the first tool_calls delta arrive simultaneously.

- **`function.name` set-once in the first tool-call delta — CONFIRMED.**
  Chunk 1 carries `"name":"get_weather"` alongside `"id":"call_jsXiqKXCwnuFZqhqQCMXPAwZ"` and
  `"type":"function"`. Subsequent chunks (2–8) carry only `"arguments":<fragment>` with no
  name or id field — set-once pattern holds for native gpt-4.1-mini.

- **`function.arguments` split across many deltas — CONFIRMED.**
  Eight consecutive argument-fragment chunks: `{\"`, `location`, `\":\"`, `Boston`, `,`,
  ` MA`, `\"}`  — each delta carries a raw JSON substring; clients must concatenate.

- **Usage chunk emitted with `choices:[]` — CONFIRMED, shape verified.**
  Chunk 10 (after `finish_reason:"tool_calls"` in chunk 9): `"choices":[]`,
  `"usage":{"prompt_tokens":75,"completion_tokens":16,"total_tokens":91,
  "prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0},
  "completion_tokens_details":{"reasoning_tokens":0,"audio_tokens":0,
  "accepted_prediction_tokens":0,"rejected_prediction_tokens":0}}`. The `stream_options.
  include_usage:true` request produced this chunk; the shape matches the SDK `CompletionUsage`
  type exactly.

- **`finish_reason` chunk has empty `delta:{}` — observed.**
  Chunk 9: `"delta":{}` (empty object, not `null` or absent) alongside
  `"finish_reason":"tool_calls"`. Worth noting for adapters that check for specific delta keys.

- **Undocumented top-level `obfuscation` field present on every chunk.**
  Each chunk carries `"obfuscation":"<opaque string>"` — not in any SDK type or docs.
  Treat as opaque server metadata; no semantic meaning for content normalization. Adapters
  must not error on unexpected top-level keys.

- **`service_tier: "default"` and `system_fingerprint` present — CONFIRMED** for native
  gpt-4.1-mini; still unverified for third-party/compatible endpoints.

- **No in-band `error` event in this capture** — consistent with docs; stream ended with
  `[DONE]` normally. §9 Q5 addressed separately.

## A.8 Proposed normalization (mapping to `agent-event-io-contract-f92c1bf.md`)

| §2 frame/field | OpenClaw stream | data shape | Notes |
|---|---|---|---|
| `delta.role` (first chunk, no content) | `lifecycle` | run/turn start marker (optional; often redundant with runtime-level lifecycle start) | Per contract, lifecycle owns run start/end, not provider role announcements — adapters may simply drop this. |
| `delta.content` (delta string) | `assistant` | `{ delta, phase: "final_answer" }` | CC has no commentary lane, so all `content` text is final-answer text. Per the contract's "OpenAI/Codex final output text" mapping row, this goes to the final reply path; if emitted as an event it carries `phase: "final_answer"` and must NOT be mirrored as hidden commentary. |
| `delta.refusal` (delta string) | `assistant` | `{ delta, phase: "final_answer" }` (refusal text is itself the model's user-visible final reply) | Treated as final-answer text in its own right — a refusal *is* the assistant's response to the user. |
| `delta.tool_calls[]` (id/type/function.name, first delta per index) | `item` (or `tool`) | `phase: "start"`, `kind: "tool"`, `toolCallId: <id>`, `name: <function.name>`, `status: "running"` | Emit "start" once name+id are known (typically the first delta for that index), per contract's "Function/tool call begin" row. |
| `delta.tool_calls[].function.arguments` (delta string, accumulated per index) | `item` | `phase: "update"`, same `toolCallId`, `progressText`/`meta` holding accumulated (redacted) argument JSON | Keep `itemId`/`toolCallId` stable across updates per contract idempotency rules; redact raw argument contents in `title`/`meta` unless channel settings permit raw detail. |
| `finish_reason: "tool_calls"` | `item` (per call) + `lifecycle` | `phase: "end"`, `status: "completed"` for each tool item; turn does not end (more provider/runtime activity follows) | Contract: "Function/tool call result" maps to `item`/`tool` end/completed — but note CC streaming itself never carries the *result*, only the completed *call*; the result event comes from the runtime executing the tool, not from this frame. |
| `finish_reason: "stop"` / `"length"` / `"content_filter"` | `lifecycle` | end phase; `"length"`/`"content_filter"` should set an error/incomplete indicator | A lifecycle end is not itself a final answer (contract §"Lifecycle and terminal events") — the accumulated `delta.content` already constitutes the final answer via the final reply path. |
| usage chunk (`usage` populated, `choices: []`) | `lifecycle` (or attached metadata on terminal lifecycle event) | `data.usage = { promptTokens, completionTokens, totalTokens }` | Not a content lane; surfaced as run metadata on the terminal lifecycle event. |
| `[DONE]` sentinel | (none — transport-level) | — | Pure SSE-stream termination signal; not itself mapped to an OpenClaw event, just closes the adapter's read loop. |
| Reasoning (none in CC) | `thinking` — **N/A, never emitted** | — | Per contract: "Private reasoning... must use a separate stream such as `thinking`, or must be dropped." Since CC never exposes any reasoning content, the adapter has nothing to map here — this row exists only to document the absence. |
| In-band errors (none in CC) | `lifecycle` (error phase), via HTTP-level error handling | `{ phase: "error", message }` | CC has no in-stream `error` frame; HTTP-level failures (non-200, connection drop) must still produce a `lifecycle` error phase from the adapter so the run terminates cleanly. |

---

# Family B — Responses API streaming

## B.2 Frame inventory

| Frame/event type | Key fields | Semantics | Source (docs § / capture file) |
|---|---|---|---|
| `response.created` | `response` (initial Response object, status `"in_progress"`), `sequence_number` | First event; announces the response object has been created and streaming has begun. | responses-streaming docs / SDK `response_stream_event.py` |
| `response.in_progress` | `response`, `sequence_number` | Periodic/heartbeat-style update that the response is still in progress (snapshot of current response state). | SDK union |
| `response.output_item.added` | `item` (full output item: `message` \| `reasoning` \| `function_call` \| `web_search_call` \| `file_search_call` \| `code_interpreter_call` \| `mcp_call` \| `mcp_list_tools` \| `image_generation_call` \| `custom_tool_call` \| ...), `output_index`, `sequence_number` | A new top-level output item has started. `output_index` is its position in `response.output[]`. The `item` is emitted in its initial (often empty/placeholder) state. | SDK `response_output_item_added_event.py` |
| `response.output_item.done` | `item` (full output item, now complete), `output_index`, `sequence_number` | The output item at `output_index` is fully populated/finalized — terminal snapshot for that item. | SDK union |
| `response.content_part.added` | `item_id`, `output_index`, `content_index`, `part` (one of `ResponseOutputText` \| `ResponseOutputRefusal` \| `PartReasoningText` (`type: "reasoning_text"`)), `sequence_number` | A new content part has been added to a `message`/`reasoning` item's `content[]` array, identified by `content_index`. | SDK `response_content_part_added_event.py` |
| `response.content_part.done` | `item_id`, `output_index`, `content_index`, `part` (full part), `sequence_number` | The content part at `content_index` is complete. | SDK union |
| `response.output_text.delta` | `item_id`, `output_index`, `content_index`, `delta` (string), `logprobs?`, `sequence_number` | Incremental text delta for an `output_text` content part of a `message` item — the user-visible answer text. | SDK `response_text_delta_event.py` |
| `response.output_text.done` | `item_id`, `output_index`, `content_index`, `text` (full text), `sequence_number` | Final/complete text for that content part — full snapshot, not a delta. | SDK union |
| `response.refusal.delta` / `response.refusal.done` | `item_id`, `output_index`, `content_index`, `delta`/`refusal`, `sequence_number` | Same delta/done pairing as output_text but for `ResponseOutputRefusal` content parts. | SDK union |
| `response.reasoning_text.delta` / `response.reasoning_text.done` | `item_id`, `output_index`, `content_index`, `delta`/`text`, `sequence_number` | Streams the model's raw reasoning content (`PartReasoningText`, `type: "reasoning_text"`) when the API/model exposes it directly (distinct from the summary). New events added specifically so raw CoT can be captured and withheld from end users (per gpt-oss cookbook). | gpt-oss "handle raw CoT" cookbook / SDK union |
| `response.reasoning_summary_part.added` / `.done` | `item_id`, `output_index`, `summary_index`, `part`, `sequence_number` | A summary part (one paragraph/segment of the reasoning summary) has been added to / completed within a `reasoning` item's `summary[]` array. | SDK union (analogous to content_part events) |
| `response.reasoning_summary_text.delta` / `.done` | `item_id`, `output_index`, `summary_index`, `delta`/`text`, `sequence_number` | Incremental / final text for one reasoning-summary segment — this is the *human-readable summary* of the model's reasoning, distinct from raw `reasoning_text` and from `encrypted_content`. | SDK union |
| `response.function_call_arguments.delta` | `item_id`, `output_index`, `delta` (string), `sequence_number` | Incremental JSON-argument-string delta for a `function_call` output item. Concatenate per `item_id`. | SDK `response_function_call_arguments_delta_event.py` |
| `response.function_call_arguments.done` | `item_id`, `output_index`, `arguments` (full string), `sequence_number` | Final, complete arguments string for that function call. | SDK union (mirrors delta event) |
| `response.mcp_call_arguments.delta` / `.done` | analogous to function_call_arguments | Same pattern for MCP tool calls. | SDK union |
| `response.code_interpreter_call.code.delta` / `.done`, `.in_progress`, `.interpreting`, `.completed` | `item_id`, `output_index`, `delta`/`code`, `sequence_number` | Lifecycle + code-content streaming for a code-interpreter tool call item. | SDK union |
| `response.web_search_call.in_progress` / `.searching` / `.completed` | `item_id`, `output_index`, `sequence_number` | Lifecycle phases for a built-in web-search tool call (no content streamed, just status). | SDK union |
| `response.file_search_call.in_progress` / `.searching` / `.completed` | same shape as web_search_call | Lifecycle phases for built-in file-search tool call. | SDK union |
| `response.image_generation_call.in_progress` / `.generating` / `.partial_image` / `.completed` | `item_id`, `output_index`, (`partial_image_b64` etc. for partial), `sequence_number` | Lifecycle + partial-result streaming for image-generation tool call. | SDK union |
| `response.audio.delta` / `.done`, `response.audio.transcript.delta` / `.done` | `item_id`, `output_index`, `content_index`, `delta`, `sequence_number` | Audio output streaming (audio-capable models). | SDK union |
| `response.output_text.annotation.added` | `item_id`, `output_index`, `content_index`, `annotation`, `annotation_index`, `sequence_number` | A citation/annotation (e.g. file citation, URL citation) was attached to streamed output text. | SDK union |
| `response.custom_tool_call_input.delta` / `.done` | `item_id`, `output_index`, `delta`/`input`, `sequence_number` | Streaming input construction for a custom (freeform) tool call. | SDK union |
| `response.queued` | `response`, `sequence_number` | Response has been queued (e.g. for background/async processing) before generation begins. | SDK union |
| `response.completed` | `response` (full Response object: `status: "completed"`, complete `output[]`, `usage`), `sequence_number` | Terminal success event — the full, final Response object snapshot, including `usage` (`input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`, `total_tokens`). | SDK `response_completed_event.py` / `response_usage.py` |
| `response.failed` | `response` (`status: "failed"`, `error`), `sequence_number` | Terminal failure event — response object with error details populated. | SDK union |
| `response.incomplete` | `response` (`status: "incomplete"`, `incomplete_details.reason`), `sequence_number` | Terminal event when generation stopped early (e.g. `max_output_tokens` reached, content filter). | SDK union |
| `error` | `code?`, `message`, `param?`, `sequence_number`, `type: "error"` | Stream-level error event, distinct from `response.failed` — can occur at any point and typically ends the stream. | SDK `response_error_event.py` |

Output item types referenced above: `message` (has `content[]` of `output_text`/`refusal` parts),
`reasoning` (has `summary[]`, optional `content[]` of `reasoning_text`, optional
`encrypted_content`, `status`), `function_call` (`name`, `arguments`, `call_id`),
`web_search_call`, `file_search_call`, `code_interpreter_call`, `image_generation_call`,
`mcp_call`, `mcp_list_tools`, `custom_tool_call`.

## B.3 Content lanes

- **Final answer text**: `message` output items, content parts of type `output_text`, streamed
  via `response.output_text.delta` and finalized by `response.output_text.done`. Multiple
  `message` items can appear in `output[]`; by convention the last `message` item with
  `role: "assistant"` is the user-facing final answer, but **any** `message` item's
  `output_text` is user-visible text (see §B.8 for the commentary-vs-final distinction).
- **Thinking/reasoning** — three distinct sub-lanes, all on `reasoning` output items:
  - **Raw reasoning content** (`reasoning.content[]`, `type: "reasoning_text"`): streamed via
    `response.reasoning_text.delta`/`.done` when the model/account is configured to expose it.
    This is the actual chain-of-thought.
  - **Reasoning summary** (`reasoning.summary[]`): a model-generated, human-readable summary of
    the reasoning, streamed via `response.reasoning_summary_part.added/.done` and
    `response.reasoning_summary_text.delta/.done`. Requested via
    `reasoning: { summary: "auto" | "concise" | "detailed" }`. This is what most callers should
    use for "show the user some thinking" UX.
  - **Encrypted reasoning** (`reasoning.encrypted_content`): an opaque encrypted blob (not
    streamed token-by-token) returned on the `reasoning` item when
    `include: ["reasoning.encrypted_content"]` is requested (typically with
    `store: false`/zero-data-retention setups). Used to pass reasoning state back to the API on
    a subsequent turn without the caller ever seeing plaintext reasoning. Appears as a field on
    the `response.output_item.done` / `response.completed` snapshot of the `reasoning` item,
    not as incremental delta events.
- **Narration/commentary/preamble**: No single dedicated "commentary" event type; interim
  assistant-visible text shows up as additional `message` output items (with their own
  `output_text` deltas) that appear *before* the final `message` item in `output[]`, typically
  interleaved with `function_call`/tool-call items. Ordering in `output[]` (and the
  `output_item.added` sequence) is the signal for "this message item came before the final
  one."
- **Tool calls + results**: `function_call` items stream their arguments via
  `response.function_call_arguments.delta/.done`. Built-in tools (`web_search_call`,
  `file_search_call`, `code_interpreter_call`, `image_generation_call`, `mcp_call`) have their
  own typed lifecycle events. Tool **results** for custom `function_call` items are not part of
  the stream — same as CC, the caller executes and sends results back as `function_call_output`
  input items on the next request. Built-in tool results (e.g. search results, generated code
  output) *are* included inline in the relevant `..._call.completed` event / final item.
- **Usage/metadata**: Only on the terminal `response.completed` event, inside `response.usage`
  — `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`,
  `output_tokens_details.reasoning_tokens`, `total_tokens`. No incremental usage events.
- **Errors**: Two paths — a stream-level `error` event (`type: "error"`, with `code`/`message`/
  `param`), and a terminal `response.failed` event with `response.status: "failed"` and an
  `error` object on the response itself. `response.incomplete` covers non-error early
  termination (e.g. hit `max_output_tokens`).

## B.4 Ordering & interleaving guarantees

- Every event carries a monotonically increasing `sequence_number` for the whole stream —
  this is the authoritative ordering key, stronger than CC's pure transport-order guarantee.
- `output_index` gives the position of an item within `response.output[]`; items are added in
  generation order via `response.output_item.added` and `output_index` values are assigned in
  increasing order as new items start.
- `content_index` (within a `message`/`reasoning` item) and `summary_index` (within a
  `reasoning` item's `summary[]`) similarly order sub-parts within an item.
- Narration/commentary `message` items and `function_call`/tool items **can and do interleave**
  at the `output[]` level — e.g. `message` (commentary) → `function_call` → `function_call` →
  `message` (final). The contract's "ordering by `seq`" guidance maps directly onto
  `sequence_number` here.
- For `reasoning` items, `summary` parts and (if present) raw `reasoning_text` content parts
  are scoped to that one `reasoning` item and precede any `message`/`function_call` items that
  depend on that reasoning, per `output_index` ordering — i.e. reasoning items appear before
  the items they "produced."
- `response.in_progress` events can appear at any point as periodic snapshots and don't carry
  new content — they're heartbeats / progress markers, not part of the content ordering.

## B.5 Delta vs snapshot semantics

- `*.delta` events (`output_text.delta`, `reasoning_text.delta`, `reasoning_summary_text.delta`,
  `refusal.delta`, `function_call_arguments.delta`, audio/code-interpreter deltas) are
  **incremental** — concatenate per `(item_id, content_index)` or `(item_id, summary_index)` or
  `item_id` as appropriate.
- `*.done` events (`output_text.done`, `reasoning_summary_text.done`,
  `function_call_arguments.done`, etc.) carry the **full final value** for that
  part/item — a snapshot, useful as a correctness check against accumulated deltas and as the
  authoritative value if a client joined mid-stream or dropped a delta.
- `response.output_item.added` / `.done` carry the **full item object** at that point in time —
  `.added` is typically a near-empty placeholder (e.g. `function_call` with empty
  `arguments: ""`), `.done` is the fully populated item. These are snapshots of the item, not
  deltas of each other.
- `response.created`, `response.in_progress`, `response.completed`, `response.failed`,
  `response.incomplete`, `response.queued` all carry a **full `Response` object snapshot** at
  that point — `response.completed`'s snapshot is authoritative and includes the entire
  `output[]` array plus `usage`.
- Net effect: a client can reconstruct full state either by accumulating deltas keyed by
  `(item_id, content_index/summary_index)`, or by trusting the periodic full-item/full-response
  snapshots (`output_item.done`, `response.completed`) as checkpoints/ground truth.

## B.6 Termination & final-frame semantics

- Successful turns end with `response.completed`, carrying the full `Response` object
  (`status: "completed"`, complete `output[]`, populated `usage`). This is the authoritative
  terminal frame.
- Failure ends with `response.failed` (`response.status: "failed"`, `response.error` populated)
  or a standalone `error` event (`type: "error"`) which may terminate the stream without a
  `response.failed` wrapper, depending on when the error occurs (pre- vs mid-generation).
- Early/truncated termination (hit token limit, content filter, etc.) ends with
  `response.incomplete` (`response.status: "incomplete"`, `response.incomplete_details.reason`).
- The **final answer** is distinguished from interim/commentary text structurally: it's the
  `output_text` content of the **last `message` item** in the final `response.output[]` array
  (as seen in `response.completed`), or equivalently the last `message`-type
  `response.output_item.done` event whose `role` is `"assistant"` and which is not followed by
  further `message` items. There is no explicit `is_final: true` flag on individual text
  events — finality is positional (last message item before `response.completed`).

## B.7 Observed dialect deviations

Verified against `captures/openai/responses-reasoning.sse` (gpt-5-mini, reasoning with summary,
2026-06-12). IMPORTANT: the capture hit an org-verification error before any reasoning or output
events were emitted; stream terminated after `response.in_progress` → `error` → `response.failed`.
All B.7 items below reflect what WAS observed plus residual-unverified items.

- **`response.in_progress` CONFIRMED to appear even for short/low-effort requests.**
  Sequence: `response.created` (seq 0) → `response.in_progress` (seq 1) → `error` (seq 2) →
  `response.failed` (seq 3). `response.in_progress` appeared immediately after `response.created`
  before any generation began — it is not gated on reasoning output length.

- **`response.created` initial object shape — CONFIRMED, richer than docs implied.**
  The `response` object in `response.created` includes `reasoning: {"context":"current_turn",
  "effort":"low","summary":"detailed"}`, `text: {"format":{"type":"text"},"verbosity":"medium"}`,
  `prompt_cache_retention:"in_memory"`, `safety_identifier:null`, `top_logprobs:0`, and
  `background:false` — fields not listed in the SDK union comment but present on wire.

- **`error` event followed immediately by `response.failed` — CONFIRMED dual-path.**
  The stream emitted both the standalone `error` event (seq 2) and then `response.failed` (seq 3)
  for the same failure. Adapters must handle both events and not double-emit a `lifecycle/error`
  — the `error` event is the actionable one; `response.failed` carries the full response snapshot.

- **`sequence_number` monotonically increasing — CONFIRMED.** Four events, seq 0–3, no gaps.

- **`response.reasoning_text.delta/.done`, `reasoning_summary_*` events — UNVERIFIED.**
  The stream failed before generation; raw CoT vs summary-only distinction cannot be confirmed
  from this capture. Caveat from B.7 draft remains open: for hosted gpt-5-mini with
  `reasoning.summary:"detailed"` but no explicit `include:["reasoning.encrypted_content"]`,
  only `reasoning_summary_*` events are expected. REQUIRES a successful reasoning capture.

- **`output_item.added` placeholder shape — UNVERIFIED.**
  Stream failed before any output items were added. The question of whether `function_call.
  arguments` starts as `""` or is absent remains open.

- **`response.in_progress` carries full response snapshot at each emission — CONFIRMED.**
  The `response.in_progress` event at seq 1 carries a complete response object identical to
  `response.created` (same field set, `output:[]`, `usage:null`). Adapters should treat these
  as heartbeats/diagnostic snapshots and NOT forward them as content events per §B.8.

## B.8 Proposed normalization (mapping to `agent-event-io-contract-f92c1bf.md`)

| §2 frame/field | OpenClaw stream | data shape | Notes |
|---|---|---|---|
| `response.created` / `response.queued` / `response.in_progress` | `lifecycle` | start/progress phase | Run-level lifecycle markers; `in_progress` snapshots are heartbeats, generally not forwarded as separate events unless useful for liveness. |
| `response.output_item.added` (`item.type: "message"`, non-final position) | `assistant` | `{ phase: "commentary", text: "" }` (placeholder; real content via text deltas) | Per contract's "OpenAI/Codex streamed output text with commentary metadata" row — a `message` item that precedes other items (especially `function_call`s) is interim/commentary. |
| `response.output_item.added` (`item.type: "message"`, the final message in the turn) | `assistant` | `{ phase: "final_answer" }` placeholder | Adapters can only know an item is "the final message" once `response.completed` confirms no further items follow — in practice, treat all `message` items as `commentary` while streaming and re-tag the last one as `final_answer` once `response.completed` arrives, OR hold the last message's deltas until completion. |
| `response.content_part.added` (`part.type: "output_text"`) | `assistant` | metadata only (no event needed standalone) | Establishes `content_index` for subsequent deltas; not independently forwarded. |
| `response.output_text.delta` (on a non-final `message` item) | `assistant` | `{ delta, phase: "commentary" }` | Per contract: "OpenAI/Codex delta frame with no full text" — forward even without `text`, per `(item_id, content_index)`. |
| `response.output_text.delta` (on the final `message` item) | `assistant` | `{ delta, phase: "final_answer" }` | Must not be mirrored as hidden commentary (contract "Must not mirror" list). |
| `response.output_text.done` | `assistant` | `{ text, phase: <commentary\|final_answer> }` | Snapshot/confirmation of the accumulated text for that item; phase matches the item's classification above. |
| `response.refusal.delta` / `.done` | `assistant` | `{ delta/text, phase: "final_answer" }` | A refusal is itself the user-facing response. |
| `response.reasoning_text.delta` / `.done` (raw CoT) | `thinking` | `{ delta/text }` — or dropped entirely | Contract: "Claude/Anthropic thinking/reasoning → `stream: 'thinking'` or drop, unless explicitly configured for reasoning display." Same rule applies to OpenAI raw reasoning; never surface as `assistant`. |
| `response.reasoning_summary_part.added/.done`, `response.reasoning_summary_text.delta/.done` | `thinking` | `{ delta/text, kind: "summary" }` | Reasoning *summaries* are still private-reasoning-derived content per the contract — route to `thinking`, not `assistant`, unless a channel explicitly enables reasoning display. |
| `reasoning.encrypted_content` (on `output_item.done`/`response.completed`) | (none — internal state) | — | Opaque, never user-visible; not an event at all — adapters persist it internally for multi-turn reasoning continuity, never emit it on the agent-event bus. |
| `response.output_item.added` (`item.type: "function_call"`) | `item` | `{ phase: "start", kind: "tool", toolCallId: call_id, name: item.name, status: "running" }` | Contract "Function/tool call begin." |
| `response.function_call_arguments.delta` | `item` | `{ phase: "update", toolCallId, progressText: <redacted accumulated args> }` | Per-`item_id` accumulation; redact raw arguments unless channel setting permits. |
| `response.function_call_arguments.done` / `response.output_item.done` (`function_call`) | `item` | `{ phase: "end", toolCallId, status: "completed" }` | Contract "Function/tool call result" — note this is the *call* completing, not a tool *result*; result comes from runtime execution. |
| `response.web_search_call.*` / `file_search_call.*` / `code_interpreter_call.*` / `image_generation_call.*` / `mcp_call.*` (`.in_progress`/`.searching`/`.completed` etc.) | `item` (kind: `"search"`/`"command"`/`"tool"` as appropriate) | `phase: "start"/"update"/"end"`, `status` per event | Maps to contract's `item` stream with `kind` chosen per built-in tool type; "search" for web/file search per the `AgentItemEventData.kind` enum. |
| `response.output_text.annotation.added` | `item` (attached to the relevant message's item/seq) or inline metadata on the `assistant` event | `meta`/citation info | Display-safe citation metadata; not a separate content lane. |
| `response.completed` | `lifecycle` | `{ phase: "end", status: "completed", usage: {...} }` | Terminal lifecycle; usage carried as metadata. Per contract, "a lifecycle end is not itself a final answer" — final answer text was already emitted via the final `message` item's `output_text` deltas/done. |
| `response.failed` | `lifecycle` | `{ phase: "error", error: {...} }` | Terminal error lifecycle. |
| `response.incomplete` | `lifecycle` | `{ phase: "end", status: "incomplete", reason: ... }` | Early-termination lifecycle, not an error per se. |
| `error` (stream-level) | `lifecycle` | `{ phase: "error", code, message, param }` | Maps directly — this is the in-band error frame the CC family lacks. |

---

# Family C — Harmony channel format (gpt-oss)

## C.2 Frame inventory

Harmony is not an HTTP/SSE wire format itself — it is the **token-level structure** that
gpt-oss (open-weight) models use internally and which inference servers/aggregators must parse
out of the raw token stream before re-exposing it via an OpenAI-compatible API (CC-style or
Responses-style). The "frames" here are control-token sequences within the model's raw output:

| Frame/event type | Key fields | Semantics | Source (docs § / capture file) |
|---|---|---|---|
| `<\|start\|>{role}` | `role`: `system` \| `developer` \| `user` \| `assistant` \| `tool` | Begins a new message, declaring who is "speaking." | github.com/openai/harmony README |
| `<\|channel\|>{channel}` | `channel`: `analysis` \| `commentary` \| `final` | Declares which channel the following message content belongs to. **Required on every assistant message** — channel must always be specified. | openai-harmony cookbook + github.com/openai/harmony |
| `<\|message\|>...content...` | freeform content tokens | The actual message payload, following the role/channel/recipient header tokens. | github.com/openai/harmony |
| `<\|end\|>` | — | Terminates the current message. | github.com/openai/harmony |
| `<\|constrain\|>{format}` | format hint (e.g. JSON schema reference) | Constrains the following message content to a structured format — used for tool-call argument payloads on the `commentary` channel. | github.com/openai/harmony |
| recipient field (on `commentary`-channel messages) | `to: functions.<tool_name>` (namespace + tool name) | Identifies the target tool/function for a `commentary`-channel message, i.e. this is how a Harmony tool call is addressed. | github.com/openai/harmony |
| `analysis`-channel message | role `assistant`, channel `analysis`, freeform text | Raw chain-of-thought / reasoning content. Meant for analysis/safety research; **not** inherently safe to show end users. | gpt-oss "handle raw CoT" cookbook |
| `commentary`-channel message | role `assistant`, channel `commentary`, optional `to:` recipient, content = tool call (often JSON, constrained) or tool-call preamble text | Carries function/tool calls and tool-call-adjacent narration/preambles. | openai-harmony cookbook |
| `final`-channel message | role `assistant`, channel `final`, freeform text | The user-facing assistant reply — the only channel intended for direct display to the end user without filtering. | openai-harmony cookbook |

## C.3 Content lanes

- **Final answer text**: the `final`-channel message content. This is the only channel that is
  unconditionally safe to show as the assistant's reply.
- **Thinking/reasoning**: the `analysis`-channel message content — raw chain-of-thought. Per
  the gpt-oss cookbook, this **should be hidden from end users by default** because it "may
  contain potentially harmful content" or reveal information the implementer didn't intend to
  expose (e.g. system/developer instructions). If shown at all, it should go through a
  safety-reviewing summarization step first — i.e. treat it like Claude's raw thinking blocks:
  internal by default, optionally surfaced behind an explicit setting.
- **Narration/commentary/preamble**: the `commentary`-channel — this is **the canonical "GPT
  narration" case** referenced by the I/O contract. `commentary` messages carry both tool calls
  (with a `to: functions.<name>` recipient and `<|constrain|>`-formatted JSON arguments) *and*
  free-text tool-call preambles/narration ("I'll check the weather now..."). The contract's row
  "Harmony `commentary` channel text → `stream: 'assistant'`, `data.phase: 'commentary'`"
  applies to the free-text narration portion of this channel; the structured tool-call portion
  maps to `item`/`tool` events instead (see §C.8).
- **Tool calls + results**: tool calls are `commentary`-channel messages with a `to:
  functions.<name>` recipient and `<|constrain|>`-typed JSON content (the call arguments). Tool
  results, when fed back to the model, arrive as `<|start|>tool<|channel|>commentary` (or
  similar tool-role) messages in the next turn's input — i.e. results re-enter via the
  `tool`-role/`commentary`-channel convention, not via a different mechanism.
- **Usage/metadata**: Not part of Harmony itself — usage accounting is a property of whichever
  outer API (CC-compatible or Responses-compatible) the inference server uses to wrap the
  parsed Harmony output; Harmony defines content structure, not usage telemetry.
- **Errors**: Not part of Harmony's token grammar — errors are a serving-layer concern (HTTP
  errors / outer-API error events), same caveat as above.

## C.4 Ordering & interleaving guarantees

- Within one sampling turn, the model can emit messages on multiple channels in sequence —
  typically `analysis` (think) → `commentary` (call a tool, with optional narration) → repeat
  for multiple tool calls → eventually `final` (respond to user). Channels are **not**
  simultaneous lanes; they are sequential messages each tagged with a channel, in raw
  generation order (token order = wire order; no separate sequence numbers — Harmony is the
  token stream itself).
- Cross-turn retention rule (explicit from the cookbook): **after a `final`-channel message
  appears, all preceding `analysis`-channel messages from prior turns should be dropped** from
  context on the next sampling turn — *unless* another tool call follows, in which case
  `analysis` content tied to that tool-call sequence may be retained. `commentary`-channel
  function calls should be retained across turns for continuity (so the model remembers what
  tools it already called).
- A single turn can contain **multiple `commentary` messages** (one per tool call) interleaved
  with `analysis` messages, all before the eventual `final` message — this is the
  multi-step-tool-use-with-narration pattern the I/O contract's `assistant`/`item` interleaving
  rules are designed for.

## C.5 Delta vs snapshot semantics

- At the raw-token level, Harmony has no "delta vs snapshot" distinction beyond what any LLM
  token stream has — tokens arrive one at a time and concatenate into the current message's
  content until `<|end|>`. There's no separate snapshot frame.
- When an inference server **re-exposes** Harmony output through an OpenAI-compatible
  Chat-Completions-shaped or Responses-shaped API (which the harmony format is explicitly
  designed to resemble — "designed to mimic the OpenAI Responses API"), the delta/snapshot
  semantics of *that* outer family (Family A or B above) apply to the re-exposed stream. The
  aggregator is responsible for mapping `analysis`/`commentary`/`final` channel boundaries onto
  that outer family's item/content-part structure (e.g. `analysis` → a `reasoning` output item,
  `commentary` tool calls → `function_call` items, `final` → the terminal `message` item, when
  re-exposed via Responses-shaped streaming).
- Per the cookbook, when re-exposed via a Chat-Completions-shaped API, raw CoT (the `analysis`
  channel) is conventionally exposed via a non-standard `reasoning` property on the delta
  (the OpenRouter convention) rather than `content` — i.e. aggregators bolt on an extra field
  rather than inventing a new top-level frame type.

## C.6 Termination & final-frame semantics

- A Harmony **message** ends at `<|end|>`. A Harmony **turn** (one full sampling step) ends
  when the model emits a `final`-channel message and that message ends — there is no separate
  "turn complete" token beyond the `final` message's own `<|end|>`, combined with the channel
  tag identifying it as the user-facing terminus.
- The **final answer** is unambiguously the `final`-channel message content — this is the
  cleanest "is this the final answer" signal of all three families, since it's an explicit tag
  rather than a positional/last-item inference (contrast with Family B, where finality is
  positional).
- If the model needs another tool-call round, it emits `commentary` (and possibly `analysis`)
  messages without a `final` message in that turn — generation continues until a `final`
  message eventually appears (or the turn is truncated by length/stop limits at the outer-API
  level).
- Truncation/length-limit/error termination is governed by whatever outer API re-exposes the
  Harmony stream (Family A's `finish_reason` or Family B's `response.incomplete`/`.failed`),
  not by Harmony's own grammar.

## C.7 Observed dialect deviations

- No live captures exist (no API key, and gpt-oss is a self-hosted/open-weight model family not
  reachable via `api.openai.com` in any case — this family is fundamentally not capturable via
  the OpenAI-hosted capture script). All content here is doc/spec-derived.
- Caveats:
  - Different inference servers (vLLM, Ollama, llama.cpp, Harmony's own reference renderer) may
    re-expose `analysis`/`commentary`/`final` channels differently in their OpenAI-compatible
    API output — e.g. some put `analysis` content in a `reasoning_content` field (DeepSeek-style
    convention) rather than OpenRouter's `reasoning` field; some drop `analysis` entirely by
    default; some fold `commentary` narration into ordinary `content` indistinguishably from
    `final`. This is the single biggest source of "dialect deviation" for this family and
    should be flagged as an open question (§C.9) until a specific aggregator's output is
    captured and compared.
  - Whether `commentary`-channel narration (free text, not the tool-call JSON itself) is
    reliably distinguishable from `final`-channel text in a given aggregator's re-exposed
    stream is unverified — some aggregators may merge both into a single `content`/`output_text`
    lane, losing the commentary/final distinction that Harmony's channel tag preserves at the
    source.

## C.8 Proposed normalization (mapping to `agent-event-io-contract-f92c1bf.md`)

This is the family the contract explicitly calls out by name (`Harmony commentary channel text`,
`Harmony final channel text`, `Harmony analysis channel text` rows in the Provider mapping
guide).

| §2 frame/field | OpenClaw stream | data shape | Notes |
|---|---|---|---|
| `analysis`-channel message | `thinking` | `{ text }` (or dropped) | Contract: "Harmony `analysis` channel text → `stream: 'thinking'` or drop." Default to drop/internal-only; never disguise as `assistant` commentary even though it superficially resembles narration. |
| `commentary`-channel message — free-text narration portion (no `to:` recipient, or text alongside a tool call) | `assistant` | `{ delta/text, phase: "commentary" }` | Contract: "Harmony `commentary` channel text → `stream: 'assistant'`, `data.phase: 'commentary'`." This is the canonical "GPT narration" — visible inter-tool-call progress text. |
| `commentary`-channel message — tool-call portion (`to: functions.<name>`, `<\|constrain\|>`-typed JSON content) | `item` | `{ phase: "start"/"update"/"end", kind: "tool", name: <function_name>, toolCallId: <derived id>, status: ... }` | Maps to contract's "Function/tool call begin/result" rows — same treatment as `function_call` items in Family B. The recipient (`to:`) field supplies `name`; the constrained JSON content supplies (redacted) arguments. |
| `final`-channel message | final reply path; if emitted as event, `assistant` with `{ phase: "final_answer" }` | `{ text/delta, phase: "final_answer" }` | Contract: "Harmony `final` channel text → final reply path and, if emitted as an event, `data.phase: 'final_answer'`." Must not be mirrored as hidden commentary. |
| Channel-boundary tokens themselves (`<\|start\|>`, `<\|channel\|>`, `<\|message\|>`, `<\|end\|>`, `<\|constrain\|>`) | (none) | — | Pure framing/control tokens consumed by the Harmony parser before normalization; never surfaced on the agent-event bus directly. |
| Tool-role messages re-entering as `commentary`-channel input (tool results fed back to the model) | `item` | `{ phase: "end", status: "completed"/"failed", ... }` (already emitted when the result was produced by the runtime) | These are *inputs* to the next sampling turn, not new output events — the corresponding `item` end event should already have been emitted when the runtime executed the tool; no duplicate event needed here. |
| Cross-turn `analysis` retention/drop rule | `thinking` (internal bookkeeping only) | — | Purely an aggregator/context-management concern; does not affect the agent-event bus since `analysis` content is dropped/internal regardless. |

---

## 9. Open questions

1. **Family A/B**: PARTIALLY RESOLVED (2026-06-12). Live captures now exist:
   `cc-tool-call.sse` (Family A, gpt-4.1-mini tool call — fully reconciled in §A.7) and
   `responses-reasoning.sse` (Family B, gpt-5-mini — stream hit org-verification error before
   generation; `response.in_progress` confirmed, dual `error`+`response.failed` confirmed,
   `sequence_number` confirmed; reasoning events and `output_item.added` shape remain unverified).
   REMAINING: re-run Family B capture against a model the org is verified for (e.g. `o4-mini`)
   to confirm reasoning event types and `output_item.added` placeholder shape.
2. **Family B**: PARTIALLY RESOLVED (2026-06-12). Capture failed before reasoning events
   appeared. The question of whether `reasoning_summary_*` is the only lane (vs
   `reasoning_text.*`) for hosted gpt-5-mini without explicit `include` cannot be confirmed
   from this capture. REMAINING: successful capture needed; expectation remains that
   `reasoning_summary_*` events appear when `reasoning.summary:"detailed"` is set, and
   `reasoning_text.*` requires explicit opt-in — consistent with docs/SDK types.
3. **Family C**: Harmony is not directly capturable via `api.openai.com` (gpt-oss is
   open-weight/self-hosted). If OpenClaw needs to validate Family C's normalization against a
   real stream, that requires a separate self-hosted gpt-oss endpoint (vLLM/Ollama) — out of
   scope for this evidence file's capture script. Flag as a follow-up evidence file
   (`evidence/captures/gpt-oss/...`) if/when such an endpoint becomes available.
4. **Family C**: Confirm how the specific aggregator(s) OpenClaw targets (if any) re-expose
   `analysis`/`commentary`/`final` — via `reasoning`/`reasoning_content` fields on a
   CC-shaped stream, via Responses-shaped `reasoning`/`message`/`function_call` items, or via
   some bespoke shape. This determines whether Family C's mapping (§C.8) is applied directly
   to a Harmony-native stream or indirectly via Family A/B's mapping after re-exposure.
5. **Family A**: PARTIALLY RESOLVED (2026-06-12). The native OpenAI gpt-4.1-mini capture
   (`cc-tool-call.sse`) does NOT emit any in-band error frame — stream terminated normally with
   `[DONE]`. The documented CC SSE format has no in-band error event, confirmed. The question
   of whether OpenClaw-targeted third-party CC-compatible endpoints emit non-standard in-band
   error frames remains open — this is a third-party-specific question not answerable from the
   native OpenAI capture. The §A.8 `lifecycle`/error mapping row (sourced from HTTP-level errors
   and abrupt connection close) remains the correct baseline; third-party error shapes (e.g.
   OpenRouter in-chunk `error` key) are handled by the F2 dialect dedup rules in SPEC.md §3.4.

---

# Family C addendum — LIVE ollama re-exposure captures (2026-06-12)

Captured on pmac (M1, ollama 0.24.0, gpt-oss:20b local): `captures/gpt-oss/` —
native `/api/chat` ×3 (default / think:"low" / tools) + OpenAI-compat
`/v1/chat/completions` ×2 (plain / tools). Answers §9 Q3/Q4 for the ollama server:

1. **Harmony `analysis` SURVIVES on both surfaces** (the worst-case "folded into
   content" did not occur on ollama 0.24):
   - native: `message.thinking` string delta field (53 deltas default, 9 at
     `think:"low"` — the think level works as a request knob);
   - OpenAI-compat: **flat `delta.reasoning`** (57 deltas) — the OpenRouter-style flat
     convention; NOT `reasoning_content`, NOT `reasoning_details[]`. Covered by the F2
     probe order (third match). No spec change needed.
2. **Ollama native is its own envelope** (analogous to claude-cli over F1): JSONL
   frames `{model, created_at, message:{role, content, thinking?, tool_calls?}, done}`;
   terminal frame `done:true, done_reason:"stop"` + perf/usage stats
   (`prompt_eval_count`, `eval_count`, durations). Notably **`tool_calls[].function.arguments
   is a parsed JSON OBJECT`** (`{"city":"Tokyo"}`), not a CC-style escaped string —
   an adapter treating it as a string will break.
3. **OpenAI-compat tool calls** are CC-conformant: `arguments` as escaped JSON string,
   id/index/type present, `finish_reason:"tool_calls"` / `"stop"` standard.
4. **Harmony `commentary` free-text (tool preambles): NOT OBSERVED** in either tool
   capture (`content` stayed empty until/absent around tool_calls). One sample — cannot
   distinguish "model emitted none" from "ollama drops it." OPEN QUESTION; matters
   because commentary preamble is the lane the whole pipeline project started from.
   Re-test with a prompt that strongly elicits preamble narration.
5. Routing recommendation for OpenClaw: consuming ollama via its OpenAI-compat surface
   loses nothing observed so far vs native (thinking survives on both); native adds
   perf stats and object-form arguments. Either is fine under the spec: compat → F2
   rules; native → needs a small envelope adapter (F2-ollama dialect note).

### Addendum update — preamble elicitation test (same day)

Second tool capture pair (`native-preamble.jsonl` / `compat-preamble.sse`) with an
explicit system instruction to narrate before tool calls: **still zero visible
content on both surfaces**, while the `analysis` lane shows the model PLANNING the
narration verbatim ("We must first tell the user what we are about to do. So we will
say something like: 'I'll retrieve the current weather for Tokyo and London.'") and
then calling the tool. Two hypotheses, undecidable from outside ollama:
(a) ollama drops Harmony `commentary` free-text; (b) gpt-oss:20b plans but skips the
preamble emission. Deciding requires raw token access (llama.cpp debug) or a vLLM
comparison capture. Consequence for the spec either way: **channels must not depend
on commentary preambles existing on this stack** — the "agent is working" promise must
be event-backed (item/tool events), which the spec already mandates (§7.1, base
contract §User promise). Validated by capture.
