# Anthropic Messages API — provider stream catalogue

Status: draft | Date: 2026-06-12 | Agent: claude (subagent, provider-content-pipeline)

## 1. Sources

- Docs (fetched 2026-06-12):
  - https://platform.claude.com/docs/en/build-with-claude/streaming (canonical event flow, full HTTP examples for text/tool-use/thinking/web-search)
  - https://platform.claude.com/docs/en/build-with-claude/extended-thinking (thinking/signature streaming semantics, interleaved thinking, redacted/omitted display modes)
  - https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use (tool_choice, model commentary before tool_use)
  - https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming (`eager_input_streaming`, partial/invalid JSON accumulation contract)
  - https://platform.claude.com/docs/en/api/messages (stop_reason enum, usage object fields, content block type directory, redacted_thinking shape)
  - https://platform.claude.com/docs/en/api/errors (HTTP error code → error.type mapping, error JSON shape)
  - Note: `docs.claude.com/en/docs/...` and `docs.anthropic.com` URLs 302-redirect to `platform.claude.com/docs/en/...`; the platform.claude.com URLs above are the resolved canonical sources.

- Captures: **capture blocked: no ANTHROPIC_API_KEY in env**. Verified via `[ -n "$ANTHROPIC_API_KEY" ]` (returned false); did not search the filesystem for credentials per task constraints.
  - A ready-to-run capture script has been written to `captures/anthropic/capture.sh`. When run with `ANTHROPIC_API_KEY` exported, it will produce:
    - `captures/anthropic/01-text-stream.sse` — plain streamed text (claude-haiku-4-5-20251001, max_tokens 100)
    - `captures/anthropic/02-thinking-stream.sse` — extended thinking (claude-sonnet-4-6, budget_tokens 1024)
    - `captures/anthropic/03-tool-use-stream.sse` — forced tool_use with a dummy `get_weather` tool
  - This catalogue's frame inventory and semantics below are therefore sourced entirely from docs examples, not live captures. §7 (dialect deviations) is empty pending a real capture.

## 2. Frame inventory

| Frame/event type | Key fields | Semantics | Source (docs § / capture file) |
|---|---|---|---|
| `message_start` | `message: {id, type:"message", role:"assistant", model, content:[], stop_reason:null, stop_sequence:null, usage:{input_tokens, output_tokens, ...}}` | First event of every stream. Carries the message envelope with empty `content`. `usage.output_tokens` here is a small placeholder (e.g. `1` or `2`), not final. | streaming.md "Event types" + all SSE examples |
| `content_block_start` | `index: int`, `content_block: {type, ...type-specific fields}` | Opens a new content block at position `index` in the final `content` array. `content_block` is a stub: `text` blocks start with `text:""`, `thinking` blocks with `thinking:"", signature:""`, `tool_use`/`server_tool_use` with `id, name, input:{}`. One exception: during server-side model-fallback, a `fallback` content block arrives as a start/stop pair with **no deltas in between** at each model boundary. | streaming.md "Event types" item 2 |
| `content_block_delta` | `index: int`, `delta: {type, ...}` | Incremental update to the block at `index`. `delta.type` is one of `text_delta`, `input_json_delta`, `thinking_delta`, `signature_delta` (citations deltas also documented for the family but not exercised in the fetched examples). | streaming.md "Content block delta types" |
| `content_block_stop` | `index: int` | Closes the block at `index`. After this event the block is complete and (for `tool_use`/`server_tool_use`) the accumulated `partial_json` should be parsed. | streaming.md "Event types" item 2 |
| `message_delta` | `delta: {stop_reason, stop_sequence}`, `usage: {...}` | One or more of these arrive near the end of the stream, carrying top-level changes to the `Message` object — primarily the final `stop_reason`/`stop_sequence` and **cumulative** usage. | streaming.md "Event types" item 3, Warning on cumulative usage |
| `message_stop` | `{"type":"message_stop"}` | Final event of every stream. No payload beyond `type`. Marks end of turn. | streaming.md "Event types" item 4 |
| `ping` | `{"type":"ping"}` | Keepalive; may appear any number of times, anywhere in the stream (seen between `content_block_start` and first delta, and mid-text-stream in examples). Carries no semantic content. | streaming.md "Ping events" |
| `error` | `{"type":"error","error":{"type":..., "message":...}}` | Sent in-stream after a 200 response when something goes wrong mid-stream (e.g. `overloaded_error` for what would be HTTP 529 outside streaming). Does not follow normal HTTP error-handling since headers/status are already committed. | streaming.md "Error events", errors.md "HTTP errors" / "Error shapes" |
| *(unknown future event types)* | n/a | Per Anthropic's versioning policy, new SSE event types may be added; clients must ignore/skip unrecognized `event:`/`type` values gracefully. | streaming.md "Other events" |

### Delta types (within `content_block_delta`)

| Delta type | Key fields | Semantics |
|---|---|---|
| `text_delta` | `text: string` | Incremental plain-text fragment appended to a `text` content block. |
| `input_json_delta` | `partial_json: string` | Incremental fragment of the JSON-serialized `input` object for a `tool_use`/`server_tool_use` block. Concatenate fragments, parse as JSON on `content_block_stop`. With `eager_input_streaming: true` (fine-grained tool streaming), fragments arrive sooner/longer but the concatenation **may not form valid JSON** (e.g. if `max_tokens` is hit mid-parameter). |
| `thinking_delta` | `thinking: string` | Incremental fragment of a `thinking` block's reasoning text. Only emitted when `display:"summarized"` (default for Claude 4 models); never emitted when `display:"omitted"`. |
| `signature_delta` | `signature: string` | Cumulative encrypted signature for a `thinking`/`redacted_thinking` block, emitted as the **last** delta before `content_block_stop` for that block. Identical regardless of `display` mode. Must be preserved byte-for-byte and replayed unmodified in subsequent turns. |
| *(citations deltas)* | — | Documented elsewhere in the citations feature family as a `content_block_delta` variant; not present in the fetched streaming examples, flagged as open question (§9). |

## 3. Content lanes

- **Final answer text**: `text` content blocks (`content_block_start` type `"text"` → `text_delta` deltas → `content_block_stop`). The *last* text block(s) before `message_delta`/`message_stop` carry the user-facing answer. There is no separate "final" marker frame — finality is inferred from `stop_reason` in `message_delta` plus the absence of further blocks.

- **Thinking/reasoning (signed/summary/redacted)**:
  - `thinking` content blocks: `content_block_start` (`thinking:"", signature:""`) → zero-or-more `thinking_delta` (only if `display:"summarized"`) → exactly one `signature_delta` → `content_block_stop`.
  - `redacted_thinking` blocks: non-streaming content block shape `{"type":"redacted_thinking","data": "<opaque>"}` — appears in the final accumulated message when reasoning is redacted (Opus/Sonnet pre-4.5 era, or certain content-flagged reasoning); in streaming form this surfaces as a `thinking` block whose `display:"omitted"` produces only a `signature_delta` (no `thinking_delta`), i.e. an empty `thinking` field plus signature.
  - With `display:"omitted"` (default for Claude Mythos/Opus 4.7+/Fable 5): block opens, receives exactly one `signature_delta`, closes — no `thinking_delta` at all. Faster time-to-first-text-token; thinking tokens are still billed.
  - Interleaved thinking (Claude 4 models, beta header `interleaved-thinking-2025-05-14`, or automatic on Opus/Sonnet 4.6+): multiple `thinking` blocks can appear throughout one assistant turn, interleaved with `tool_use` blocks — each gets its own full start/delta(s)/signature/stop sequence. `budget_tokens` for interleaved thinking represents the total budget across all thinking blocks in the turn and can exceed `max_tokens`.
  - Thinking and redacted_thinking blocks from the prior assistant turn **must be passed back unmodified** (including empty `thinking` fields); editing/reordering/filtering them causes a 400 `invalid_request_error`.

- **Narration/commentary/preamble (interim assistant text between tool calls)**: Carried as ordinary `text` content blocks that appear *before* a `tool_use`/`server_tool_use` block in the same turn (e.g. "Okay, let's check the weather for San Francisco, CA:" preceding the `get_weather` tool_use in the docs example). The wire format gives no explicit "commentary vs final" flag on these blocks — distinguishing commentary from a final answer requires knowing whether further blocks (tool_use, more text) follow in the same turn, i.e. it is a structural/positional signal, not a field.

- **Tool calls + results**:
  - Tool call request: `tool_use` (client tools) or `server_tool_use` (Anthropic server-side tools like `web_search`) content blocks. `content_block_start` carries `id`, `name`, `input:{}` (placeholder empty object); `input_json_delta` deltas carry the real `input` as concatenated `partial_json`.
  - Server-tool results stream back as their own content blocks in the same turn, e.g. `web_search_tool_result` (`content_block_start` with `tool_use_id` and a `content` array of `web_search_result` items, immediately followed by `content_block_stop` with no deltas — it's a snapshot, not incremental). Similar result block types exist for `web_fetch`, code execution, bash, text editor, tool search (documented in the Messages API content-block directory, not exercised in fetched SSE examples).
  - Tool *results the caller sends back* (`tool_result` blocks) are part of the next request's input, not part of this stream — out of scope for this catalogue's frame inventory but relevant to §8 mapping (they close the loop for `item`/`tool` lifecycle).

- **Usage/metadata**: `usage` appears in `message_start.message.usage` (initial small snapshot: `input_tokens` + tiny `output_tokens`) and in every `message_delta.usage` (cumulative). Cumulative usage object includes `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation: {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`, `output_tokens_details: {thinking_tokens}`, `server_tool_use: {web_search_requests, web_fetch_requests}`, `service_tier`, `inference_geo`.

- **Errors**: in-stream `error` event (`{"type":"error","error":{"type":..., "message":...}}`) after the 200 response has already started — e.g. `overloaded_error` (HTTP 529 equivalent). Pre-stream HTTP-level errors use the standard `{"type":"error","error":{"type":..., "message":...}, "request_id":...}` shape with status-code-mapped `error.type` (`invalid_request_error` 400, `authentication_error` 401, `billing_error` 402, `permission_error` 403, `not_found_error` 404, `request_too_large` 413, `rate_limit_error` 429, `api_error` 500, `timeout_error` 504, `overloaded_error` 529).

## 4. Ordering & interleaving guarantees

- Strict overall ordering: `message_start` → N × (`content_block_start` / `content_block_delta`* / `content_block_stop`) → 1+ × `message_delta` → `message_stop`. `ping` and `error` can appear anywhere in this sequence (error terminates the stream early).
- `index` in `content_block_*` events corresponds exactly to the position of that block in the final `Message.content` array — blocks are emitted in increasing index order, one at a time (block N's `content_block_stop` precedes block N+1's `content_block_start`); the docs examples show no concurrent/interleaved indices.
- Within a single assistant turn, blocks of different types can interleave in sequence: `text` (commentary) → `tool_use`/`server_tool_use` → (server-only) result block → `text` (continuation) → ... With extended thinking, a `thinking` block is typically index 0 (thinking-first ordering for a simple non-interleaved turn); with interleaved thinking, additional `thinking` blocks can recur between later `tool_use` blocks, each at its own sequential index.
- Within a `thinking` block: all `thinking_delta` events come before the single `signature_delta`, which comes immediately before `content_block_stop`. Within a `tool_use`/`server_tool_use` block: all `input_json_delta` events come before `content_block_stop`; the first delta may be an empty `partial_json:""`.
- `fallback` content blocks (server-side model fallback) appear as a `content_block_start`/`content_block_stop` pair with **no deltas**, at each model-boundary transition — these consume an index like any other block.
- Chunking is not token-granular and not guaranteed uniform: docs explicitly note "chunky" delivery (larger batches alternating with smaller token-by-token chunks), especially for thinking content, with possible delays between events.

## 5. Delta vs snapshot semantics

- **Incremental (delta) frames**: `content_block_delta` of all sub-types (`text_delta`, `thinking_delta`, `input_json_delta`, `signature_delta` — the latter is technically "cumulative in one shot" since it's emitted once as the full signature, but arrives via the delta event type).
- **Snapshot/placeholder frames**: `content_block_start` content_block stubs are snapshots of the *shape* but not the *content* — `text:""`, `thinking:"", signature:""`, `tool_use.input:{}` are placeholders to be filled by subsequent deltas. Server-tool result blocks (e.g. `web_search_tool_result`) are full snapshots delivered entirely within `content_block_start` with no deltas.
- **Cumulative frames**: `message_delta.usage` token counts are cumulative across the whole response, not incremental per-`message_delta` event (explicit doc warning). `message_start.message.usage` is the initial input-side usage snapshot plus a placeholder output count.
- **Reassembly rule**: to reconstruct the final `Message`, start from `message_start.message` (content `[]`), then for each block append a content entry built from `content_block_start.content_block` with `text`/`thinking`/`input` fields progressively overwritten by concatenating/parsing the corresponding deltas as `content_block_stop` arrives; finally merge `message_delta.delta` (`stop_reason`, `stop_sequence`) and the last `message_delta.usage` into the top-level message. SDK helpers (`get_final_message`/`finalMessage`/`Accumulate`/`MessageAccumulator`/`accumulated_message`) implement exactly this.
- `input_json_delta` requires string concatenation then a single JSON parse at block close — never parse partial fragments as JSON unless `eager_input_streaming` is enabled and you have an incremental/partial JSON parser (and even then completeness is not guaranteed).

## 6. Termination & final-frame semantics

- A turn ends with `message_stop` (`{"type":"message_stop"}`), always preceded by at least one `message_delta` carrying the final `stop_reason`/`stop_sequence` and the final cumulative `usage`.
- `stop_reason` enum and meaning:
  - `end_turn` — natural completion; the preceding text block(s) are the final answer.
  - `max_tokens` — output truncated at `max_tokens` or model max; any open block (esp. `tool_use`/thinking with `eager_input_streaming`) may be incomplete/invalid.
  - `stop_sequence` — a configured `stop_sequences` string was generated; `message_delta.delta.stop_sequence` names which one.
  - `tool_use` — the model invoked one or more tools; caller must execute them and send `tool_result` blocks in a follow-up request to continue the turn.
  - `pause_turn` — a long-running turn (e.g. extensive server-tool use) was paused; caller resumes by sending the partial response back in a subsequent request.
  - `refusal` — streaming safety classifiers intervened mid-stream for a potential policy violation; treat any partial content as non-final/unsafe to surface as a normal answer.
- Distinguishing "final answer" text from "interim/commentary" text is **positional, not field-based**: a `text` block is final only if no further content blocks follow before `message_delta`/`message_stop` AND `stop_reason` is `end_turn` (or `stop_sequence`/`max_tokens` if that's where generation stopped). A `text` block followed by a `tool_use` block (stop_reason `tool_use`) is commentary/preamble for that turn, not the final answer — the *true* final answer arrives only after the tool-result round trip produces a later turn ending in `end_turn`.
- `error` events terminate the stream without a normal `message_stop`/`message_delta` sequence — treat as abnormal termination.
- Error recovery (Claude 4.5 and earlier): capture partial content, resend as the tail of a new assistant message and continue streaming. Claude 4.6+: capture partial content, instead send it back inside a *user* message with an explicit "continue from where you left off" instruction. In both cases, `tool_use`/`thinking` blocks cannot be partially recovered — recovery resumes from the most recent complete `text` block.

## 7. Observed dialect deviations

Captures run 2026-06-12: `01-text-stream.sse` (claude-haiku-4-5-20251001), `02-thinking-stream.sse` (claude-sonnet-4-6, budget_tokens 1024), `03-tool-use-stream.sse` (claude-haiku-4-5-20251001).

### Checklist items

**Ping frequency/placement** — CONFIRMED with minor observation. All three captures show exactly one `ping` event, placed after `content_block_start` and before the first delta of the first content block (01 line 7–8, 02 line 7–8, 03 line 7–8). No pings mid-stream or elsewhere. Docs say "any number, anywhere" — live behavior is one ping, consistently placed at block-open. Not a contradiction (subset of "anywhere"), but worth noting for timeout tuning.

**`message_start.message.usage` placeholder `output_tokens`** — CONFIRMED. Values: `2` (01 line 2), `1` (02 line 2), `5` (03 line 2). All small integers matching the docs "e.g. `1` or `2`" description. Note `5` for the tool-use capture is slightly larger than the `1`/`2` cited in docs examples, still clearly a placeholder.

**`signature_delta` single-event vs. chunked** — CONFIRMED single event. Cap 02 line 20: one `signature_delta` event containing the complete signature string before `content_block_stop`. No chunked delivery observed.

**`input_json_delta` chunking granularity** — CONTRADICTS DOCS. Docs state "Current models only support emitting one complete key and value property from `input` at a time." Cap 03 lines 11–26 show 6 deltas for `{"location": "San Francisco, CA"}`: `""`, `{"locati`, `on": "San`, ` Fran`, `cisco, C`, `A"}` — the key is split mid-name across multiple deltas. Sub-key chunking is the actual live behavior, not whole-key-at-a-time.

### Additional deviations found in captures

**`stop_details: null` — undocumented field.** All three captures include `"stop_details":null` in `message_start.message` (01 line 2, 02 line 2, 03 line 2) and in `message_delta.delta` (01 line 17, 02 line 50, 03 line 32). This field is absent from the docs-described event shapes. Always `null` in these captures; likely reserved for future use or used by `pause_turn`.

**`caller` field on `tool_use` content block start — undocumented field.** Cap 03 line 5: `content_block_start` for the `tool_use` block includes `"caller":{"type":"direct"}`. This field does not appear in the docs `content_block_start` shape for `tool_use`. May indicate routing context (direct API call vs. server-tool proxy).

**`service_tier` and `inference_geo` in `message_start.message.usage`.** Cap 01 line 2: `"service_tier":"standard","inference_geo":"not_available"`. Cap 02 line 2: `"service_tier":"standard","inference_geo":"global"`. Cap 03 line 2: same as 01. Docs list these as usage fields (§3, usage object) but examples do not show them present in `message_start` — only in `message_delta`. Live captures show them in both. `inference_geo` values differ by model/request: `"not_available"` (haiku) vs `"global"` (sonnet-4-6).

**`output_tokens_details` in `message_delta.usage` for thinking streams.** Cap 02 line 50: `"output_tokens_details":{"thinking_tokens":62}`. This is documented but only appears when a thinking block is present; confirmed present and correctly populated. Not in cap 01 or 03 (no thinking blocks).

**`thinking_delta` chunking is sub-sentence, not token-by-token.** Cap 02 lines 11–17: 3 thinking deltas with lengths roughly 5, ~80, and 6 characters — chunky batch delivery, not uniform token streaming. Consistent with docs warning about "chunky" delivery for thinking content.

**`thinking` block in cap 02 uses `display:"summarized"` behavior (thinking_delta present).** Confirmed: cap 02 model is claude-sonnet-4-6 with budget 1024 → thinking block at index 0 has multiple `thinking_delta` events followed by a single `signature_delta`. This is the summarized/raw display path, not omitted.

## 8. Proposed normalization

Mapping to OpenClaw streams per `reference/agent-event-io-contract-f92c1bf.md` (`assistant` phase commentary|final_answer, `thinking`, `tool`/`item`, `lifecycle`). Total over §2:

| Anthropic SSE frame / delta | OpenClaw stream | data shape | Notes |
|---|---|---|---|
| `message_start` | `lifecycle` | `{phase:"start", data:{provider:"anthropic", model, messageId, usage:message.usage}}` | Run/turn start. Not itself a final answer (per contract). |
| `content_block_start` (`type:"text"`) | `assistant` | `{delta:"", phase:"commentary"}` initially; phase resolved retroactively (see below) | Open a text segment. Phase cannot be determined until the turn's `stop_reason` and subsequent blocks are known — adapters should buffer/tag and reclassify, or default to `"commentary"` and only mark the terminal end_turn text segment as `final_answer` once `message_delta.delta.stop_reason === "end_turn"` and no further blocks follow. |
| `content_block_delta` (`text_delta`) | `assistant` | `{delta: event.delta.text, phase: <inherited from owning block>}` | Delta-only frame; forward even without `text`, per contract rule "delta with no text is valid." |
| `content_block_stop` (text block) | `assistant` | `{phase: <inherited>, status:"completed", text: <accumulated>}` | Snapshot/completion marker for the segment; if this is the final end_turn text block, emit/forward as `final_answer` and do NOT mirror to commentary. |
| `content_block_start` (`type:"thinking"` or `type:"redacted_thinking"`) | `thinking` | `{itemId, phase:"start", redacted: type==="redacted_thinking"}` | Per provider mapping guide: "Claude/Anthropic thinking/reasoning → `stream: thinking` or drop, unless explicitly configured for reasoning display." Never emit as `assistant`. |
| `content_block_delta` (`thinking_delta`) | `thinking` | `{itemId, delta: event.delta.thinking}` | Only present when `display:"summarized"`. |
| `content_block_delta` (`signature_delta`) | `thinking` | `{itemId, signature: event.delta.signature}` | Internal/opaque; must not be surfaced to channels. Required for multi-turn replay by the provider adapter's own state, not for display. |
| `content_block_stop` (thinking/redacted_thinking block) | `thinking` | `{itemId, phase:"end"}` | Closes the reasoning item. |
| `content_block_start` (`type:"tool_use"` or `type:"server_tool_use"`) | `item` (and/or `tool`) | `{itemId: content_block.id, phase:"start", kind:"tool", name: content_block.name, status:"running", toolCallId: content_block.id}` | Emit before execution — provider already knows the call shape (id/name) at block start, input fills in via deltas. |
| `content_block_delta` (`input_json_delta`) | `item` | `{itemId, phase:"update", progressText: <redacted/accumulated input or just a progress signal>}` | Raw arguments should be redacted/summarized per "Security and privacy" — do not forward raw `partial_json` verbatim to channels unless detail is explicitly enabled. |
| `content_block_stop` (tool_use/server_tool_use block) | `item` | `{itemId, phase:"update", status:"running", meta: <parsed input summary>}` | Marks tool call fully specified; actual `end` phase awaits the tool result. |
| `content_block_start`/`stop` (`web_search_tool_result`, `web_fetch_tool_result`, `*_tool_result`, etc.) | `item` | `{itemId: tool_use_id, phase:"end", status:"completed", kind:"tool", summary: <derived from result content>}` | Snapshot result blocks (no deltas) map directly to a single `end` update for the matching `itemId`/`toolCallId`. |
| `content_block_start`/`stop` (`type:"fallback"`, no deltas) | `lifecycle` | `{phase:"update", data:{event:"model_fallback"}}` | Model-boundary marker during server-side fallback; not user-visible content. |
| `message_delta` | `lifecycle` + `assistant`(finalization) | `{phase:"update", data:{stop_reason, stop_sequence, usage}}`; if `stop_reason==="end_turn"`/`stop_sequence"`, also finalize the last text segment as `final_answer` via the final reply path | Cumulative usage attaches to lifecycle/usage metadata, not to commentary. |
| `message_stop` | `lifecycle` | `{phase:"end"}` | Terminal lifecycle event. Per contract, this is NOT itself the final answer — final answer text was already finalized off the last `text` block / `message_delta`. |
| `ping` | *(dropped)* | — | No semantic content; not emitted onto the agent-event bus. |
| `error` (in-stream) | `lifecycle` | `{phase:"error", data:{providerErrorType: error.error.type, message: error.error.message}}` | Stops forwarding further commentary/tool progress for the run per abort-guard rules; `overloaded_error`/`rate_limit_error`/etc. surface as run errors. |
| Inter-tool narration (`text` block with `stop_reason:"tool_use"` pending) | `assistant` | `{delta/text, phase:"commentary"}` | Per provider mapping guide row "Claude/Anthropic inter-tool narration → `assistant`, `phase:"commentary"` when it is visible narration." |

## 9. Open questions

- Citations deltas (`citations_delta` or similar) are referenced in the broader Anthropic docs ecosystem for citation-enabled responses but did not appear in any of the fetched streaming examples — needs a targeted fetch of the citations feature page if OpenClaw needs to normalize citation streaming.
- RESOLVED: The exact live cadence/placement of `ping` events. Cap 01/02/03 each show exactly one `ping` after the first `content_block_start` and before its first delta. No mid-stream pings in these short captures. "Any number, anywhere" remains formally true per docs; live behavior in these captures is one ping per stream at block-open. Longer/tool-heavy streams may differ.
- Whether `redacted_thinking` ever appears as its own distinct `content_block_start.content_block.type` value in a *streaming* response (vs. only in the non-streaming `Message.content` array, with streaming instead representing the omitted case via a `thinking` block with empty `thinking_delta`s) is not fully disambiguated by the fetched docs — both framings appear across different doc pages. Not resolved by captures (cap 02 used budget 1024 on sonnet-4-6 and produced a summarized thinking block, not a redacted one).
- `model_context_window_exceeded` as a `stop_reason` was hypothesized in the task framing but not found in the fetched `stop_reason` enum (only `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal` are documented) — needs verification against the live API or changelog if OpenClaw's normalization table assumes it exists.
- RESOLVED: §7 dialect deviations — populated from captures 01–03. See §7 for full findings. Outstanding sub-questions: `eager_input_streaming` behavior not tested (these captures used standard streaming); `redacted_thinking` streaming block shape not observed in captures.
