# claude-cli stream-json — provider stream catalogue

Status: draft | Date: 2026-06-12 | Agent: Doc (claude-marvin capture)

## 1. Sources

- Docs: none consulted directly; behavior derived from live capture + OpenClaw
  consumer code (read-only).
- Captures (live, subscription auth via `claude-marvin` wrapper, no API key):
  - `captures/claude-cli/plain.jsonl` — command:
    `~/.local/bin/claude-marvin -p 'Reply with exactly: capture-ok' --output-format stream-json --include-partial-messages --verbose`
    (15 frames, exit 0, ~8.3s wall)
  - `captures/claude-cli/reasoning.jsonl` — command:
    `~/.local/bin/claude-marvin -p 'Think step by step: what is 17*23? Show only the final number.' --output-format stream-json --include-partial-messages --verbose`
    (11 frames, exit 0, ~6.3s wall)
  - Both stderr files (`stderr-plain.txt`, `stderr-reasoning.txt`) are empty —
    clean runs, no warnings.
  - Model reported in both captures: `claude-fable-5` (this machine's model
    alias), `claude_code_version: 2.1.173`.
- Capture status: both runs completed well under the 60s budget. No hangs, no
  kills needed.

## 2. Frame inventory

| Frame/event type | Key fields | Semantics | Source (capture file) |
|---|---|---|---|
| `system` / `subtype: "init"` | `cwd`, `session_id`, `tools[]`, `mcp_servers[]`, `model`, `permissionMode`, `slash_commands[]`, `apiKeySource`, `claude_code_version`, `output_style`, `agents[]` | First frame of every run. Declares session id, available tools/agents/slash-commands, and that no raw API key is in use (`apiKeySource: "none"` — subscription/OAuth auth). | plain.jsonl:1, reasoning.jsonl:1 |
| `system` / `subtype: "status"` | `status: "requesting"`, `uuid`, `session_id` | Lifecycle ping marking the CLI is about to send the request to the model. | plain.jsonl:2, reasoning.jsonl:2 |
| `rate_limit_event` | `rate_limit_info: { status, resetsAt, rateLimitType, overageStatus, overageDisabledReason, isUsingOverage }`, `uuid`, `session_id` | Subscription rate-limit snapshot (five-hour window state) emitted before model output begins. Specific to subscription/CLI auth, not present on raw Anthropic Messages API streams. | plain.jsonl:3, reasoning.jsonl:3 |
| `stream_event` / `event.type: "message_start"` | `event.message: { model, id, type:"message", role:"assistant", content:[], stop_reason:null, stop_details:null, usage }` | Wraps the Anthropic SSE `message_start` event verbatim. `usage` here is the pre-output snapshot (input/cache tokens, `service_tier`, `inference_geo`). | plain.jsonl:4, reasoning.jsonl:4 |
| `stream_event` / `event.type: "content_block_start"` | `event.index`, `event.content_block: { type: "thinking"\|"text"\|..., ... }` | Wraps Anthropic SSE `content_block_start`. Announces a new content block (thinking or text in these captures) at a given index. | plain.jsonl:5 (thinking, index 0), plain.jsonl:8 (text, index 1), reasoning.jsonl:5 (text, index 0) |
| `stream_event` / `event.type: "content_block_delta"`, `delta.type: "signature_delta"` | `event.index`, `delta.signature` (base64 blob) | Wraps Anthropic SSE thinking-signature delta — the cryptographic signature for a (here, empty) thinking block. Appears only in `plain.jsonl`. | plain.jsonl:6 |
| `stream_event` / `event.type: "content_block_delta"`, `delta.type: "text_delta"` | `event.index`, `delta.text` | Wraps Anthropic SSE text delta — incremental visible-answer text. | plain.jsonl:9 (`"capture-ok"`), reasoning.jsonl:6 (`"391"`) |
| `stream_event` / `event.type: "content_block_stop"` | `event.index` | Wraps Anthropic SSE `content_block_stop` — closes the block at `index`. | plain.jsonl:7 (thinking block), plain.jsonl:11 (text block), reasoning.jsonl:7 (text block) |
| `stream_event` / `event.type: "message_delta"` | `delta: { stop_reason, stop_sequence, stop_details }`, `usage: { input_tokens, cache_*_tokens, output_tokens, output_tokens_details: { thinking_tokens }, iterations[], ... }`, `context_management: { applied_edits: [] }` | Wraps Anthropic SSE `message_delta` — final stop reason plus the authoritative usage totals for the turn, including `thinking_tokens`. | plain.jsonl:12, reasoning.jsonl:9 |
| `stream_event` / `event.type: "message_stop"` | (no extra fields besides envelope) | Wraps Anthropic SSE `message_stop` — terminates the assistant message stream. | plain.jsonl:13, reasoning.jsonl:10 |
| `assistant` | `message: { model, id, type:"message", role:"assistant", content:[...], stop_reason, stop_sequence, stop_details, usage, diagnostics, context_management }`, `parent_tool_use_id`, `session_id`, `uuid`, `request_id` | Full-snapshot assistant message frame, emitted once per content block completed (one after the thinking block closes, one after the text block closes in plain.jsonl; once after the text block in reasoning.jsonl). `message.content` is the array of completed blocks accumulated so far. | plain.jsonl:6 (thinking-only), plain.jsonl:10 (thinking+text), reasoning.jsonl:8 (text) |
| `result` | `subtype: "success"`, `is_error`, `api_error_status`, `duration_ms`, `duration_api_ms`, `ttft_ms`, `ttft_stream_ms`, `time_to_request_ms`, `num_turns`, `result` (final text string), `stop_reason`, `session_id`, `total_cost_usd`, `usage` (full usage incl. `cache_creation`, `server_tool_use`, `iterations`, `inference_geo`, `speed`), `modelUsage` (per-model cost/usage breakdown, e.g. `claude-haiku-4-5-...` for title/sidecar model plus the main `claude-fable-5`), `permission_denials[]`, `terminal_reason`, `fast_mode_state`, `uuid` | Terminal frame. Always last line of the JSONL stream. `is_error: false` + `subtype: "success"` + `terminal_reason: "completed"` signal a clean end; `result` carries the final answer text (redundant with the last `assistant` text block). | plain.jsonl:15, reasoning.jsonl:11 |

No other frame types appeared in either capture (no `error`, `user`, `control_request`/`control_response`, or `tool_use`/`tool_result` frames — these prompts triggered no tools).

## 3. Content lanes

- **Final answer text**: carried in two redundant places — (a) the `text` content block inside the last `assistant` snapshot frame's `message.content`, and (b) the `result` frame's top-level `result` string. Both matched the captured prompts exactly (`"capture-ok"`, `"391"`).
- **Thinking/reasoning**: present in `plain.jsonl` as a `content_block_start` with `content_block.type: "thinking"` (empty `thinking` text, empty `signature` at start), followed by a `content_block_delta` with `delta.type: "signature_delta"` carrying a base64 signature blob, then `content_block_stop`. The thinking *text* itself was empty in this capture — only the signature was streamed. The completed `assistant` snapshot for that block shows `content: [{ type: "thinking", thinking: "", signature: "<base64>" }]`. `reasoning.jsonl` had **no thinking block at all** — `output_tokens_details.thinking_tokens: 0` in its `message_delta`, vs. `thinking_tokens: 19` in plain.jsonl despite plain.jsonl's prompt not asking for reasoning and reasoning.jsonl's prompt explicitly asking to "think step by step." This indicates the model's internal extended-thinking allocation is not deterministically tied to prompt phrasing for this alias/effort setting, and an empty-text thinking block (signature-only) can still occur.
- **Narration/commentary/preamble**: none observed — both prompts produced a single text block with no interim assistant narration between tool calls (no tools were called).
- **Tool calls + results**: not exercised by either capture (no `tool_use`/`tool_result` content blocks, no `content_block_start` with `content_block.type` in `{tool_use, server_tool_use, mcp_tool_use}`).
- **Usage/metadata**: usage appears at three points with increasing completeness — (1) `message_start.message.usage` (pre-output snapshot: input/cache tokens, `service_tier`, `inference_geo`), (2) `message_delta.usage` (adds `output_tokens`, `output_tokens_details.thinking_tokens`, `iterations[]`), (3) `result.usage` (full picture incl. `server_tool_use`, `cache_creation`, `speed`) plus `result.total_cost_usd` and `result.modelUsage` (per-model cost breakdown — notably includes a `claude-haiku-4-5-*` entry alongside the primary `claude-fable-5` entry, i.e. a sidecar/title-generation model call billed in the same turn).
- **Errors**: not exercised. The consumer code (`src/agents/cli-output.ts`) handles `parsed.type === "error"` and `is_error === true` on `result` frames, and detects `API Error:`-prefixed text inside `assistant` message content as an error signal — but neither capture produced these.

## 4. Ordering & interleaving guarantees

Strict linear order observed: `system/init` → `system/status(requesting)` → `rate_limit_event` → `stream_event(message_start)` → for each content block: `stream_event(content_block_start)` → zero or more `stream_event(content_block_delta)` → `stream_event(content_block_stop)` → one `assistant` snapshot frame reflecting the block(s) completed so far → `stream_event(message_delta)` → `stream_event(message_stop)` → `result`.

`event.index` on `content_block_*` events is the Anthropic content-block index (0-based, monotonically increasing across the message). The `assistant` snapshot frame is emitted once per completed block (interleaved with the `stream_event` stream, not batched at the end) — in plain.jsonl there are two `assistant` frames (after the thinking block and after the text block), each carrying the full `message.content` accumulated to that point. No narration/commentary frames can interleave with tool calls in these captures since no tools ran; the contract's "Claude/Anthropic inter-tool narration" case did not occur.

## 5. Delta vs snapshot semantics

- `stream_event(content_block_delta)` frames are **incremental** — `delta.text` / `delta.signature` / (not seen here) `delta.partial_json` must be concatenated per `index` to reconstruct the block.
- `assistant` frames are **full snapshots** of `message.content` as completed so far — each one supersedes the prior `assistant` frame's content array (it is not itself incremental, but its `content` array grows monotonically block-by-block).
- `message_delta` carries the final `usage`/`stop_reason` as a **snapshot**, not a delta despite the name (Anthropic SSE naming convention).
- `result.result` and `result.usage` are the final **authoritative snapshots** for the whole turn.
- Reassembly rule for a consumer that only reads `stream_event`: accumulate `content_block_delta.delta.text` per index between matching `content_block_start`/`content_block_stop`; ignore `signature_delta` unless thinking-signature reconstruction is needed.

## 6. Termination & final-frame semantics

- The turn ends with `stream_event(message_stop)` immediately followed by the terminal `result` frame — `result` is always the last JSONL line.
- `result.subtype: "success"`, `result.is_error: false`, `result.terminal_reason: "completed"` together signal a clean, complete turn. `result.stop_reason` mirrors the Anthropic `stop_reason` (`"end_turn"` in both captures).
- The final answer is unambiguous: it is the `text` block's accumulated content in the last `assistant` snapshot, **and** is independently restated in `result.result`. A consumer needs only one of these; OpenClaw's parser (see §7) uses the `result.result` string as authoritative and the streamed `content_block_delta` text for live progress.
- `result.duration_ms` vs `result.duration_api_ms` vs `result.ttft_ms`/`ttft_stream_ms`/`time_to_request_ms` give wall-clock vs. API vs. time-to-first-token breakdowns — useful for latency diagnostics but not part of content semantics.

## 7. Observed dialect deviations

- The `stream_event` wrapper is a thin envelope: `{ type: "stream_event", event: <raw Anthropic SSE event>, session_id, parent_tool_use_id, uuid }`. The inner `event` object is the **unmodified** Anthropic Messages API streaming event shape (same `type` values: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`).
- CLI-only additions not in the raw Anthropic Messages API: `system/init`, `system/status`, `rate_limit_event`, the full-snapshot `assistant` frames interleaved with `stream_event`s, and the terminal `result` frame with cost/usage/session aggregation.
- `result.modelUsage` includes a secondary model (`claude-haiku-4-5-20251001` in both captures) used for a sidecar task (likely conversation title generation) — this is a CLI-session artifact, not something a raw Messages API caller would see.
- An empty-text, signature-only `thinking` block appeared in the *non*-reasoning prompt (plain.jsonl) while the explicitly-reasoning prompt (reasoning.jsonl) produced no thinking block and `thinking_tokens: 0`. Thinking-block presence/absence did not correlate with prompt phrasing in this small sample — treat thinking-block presence as non-deterministic per turn.
- `apiKeySource: "none"` in `system/init` confirms this capture used subscription/OAuth auth via the `claude-marvin` wrapper, not a raw `ANTHROPIC_API_KEY`.

## 8. Proposed normalization

Mapping observed frames (§2) to OpenClaw streams per
`reference/agent-event-io-contract-f92c1bf.md` §"Provider input contract" /
§"Provider mapping guide". This table is total over §2.

| Frame (type / event.type) | OpenClaw stream | data shape |
|---|---|---|
| `system/init`, `system/status`, `rate_limit_event` | `lifecycle` | run-setup metadata; not assistant-visible. `rate_limit_event` could feed a `lifecycle` diagnostic field but must not be shown as commentary. |
| `stream_event(message_start)` | `lifecycle` (start) | marks model response begun; pre-output `usage` snapshot goes to lifecycle/diagnostic data, not `assistant`. |
| `stream_event(content_block_start, content_block.type:"thinking")` | `thinking` (phase start) | per contract: "Claude/Anthropic thinking/reasoning → `stream: "thinking"` or drop, unless explicitly configured for reasoning display." |
| `stream_event(content_block_delta, delta.type:"signature_delta")` | `thinking` (delta, or dropped) | signature bytes are provider-only trace; forward only if reasoning display is configured, otherwise drop per contract — must never be disguised as `assistant` commentary. |
| `stream_event(content_block_delta, delta.type:"text_delta")` | `assistant`, `data.delta` | per contract: "delta-only assistant frames emit and survive normalization." `phase` omitted unless a later signal marks it `final_answer`; for a single-text-block turn this is effectively the final answer text streaming in. |
| `stream_event(content_block_start, content_block.type:"text")` / `content_block_stop` | `assistant` (phase boundary) or `item` (phase start/end) — implementation detail; no content to emit on its own beyond marking segment boundaries. | |
| `stream_event(content_block_start/delta/stop, content_block.type in {tool_use, server_tool_use, mcp_tool_use})` (not observed, but per cli-output.ts parser) | `item` / `tool`, start→running, stop→completed/failed | per "Function/tool call begin" and "result" mapping rows; OpenClaw's `dispatchClaudeCliStreamingToolEvent` already reconstructs `toolCallId`/`name`/`args` from these. |
| `stream_event(message_delta)` | `lifecycle` (usage update) + (if final block was text) `assistant data.phase:"final_answer"` once stop_reason confirms turn end | usage/cost fields go to lifecycle metadata, not assistant text. |
| `stream_event(message_stop)` | `lifecycle` (end of model turn) | not itself a final answer per contract — final answer text comes via the final reply path. |
| `assistant` (full snapshot frame) | source of truth for `assistant data.text` (final reply path) and for tool reconstruction (`dispatchClaudeCliStreamingToolEvent` reads `message.content` tool_use/tool_result blocks here) | OpenClaw's existing parser treats this as "Non-streaming provider with one final response" fallback when `stream_event` deltas are absent. |
| `result` (subtype success) | `lifecycle` (terminal) + final reply path uses `result.result` text | "Non-streaming provider with one final response... unless the provider emits separate progress" — here separate progress *was* emitted via `stream_event`, so `result` is purely terminal/lifecycle plus the authoritative final-text fallback. |
| `result` (`is_error: true`) | `lifecycle` (error) | maps to the contract's lifecycle error phase; `createResultError` in `claude-live-session.ts` already classifies this into a `FailoverError`. |

### What OpenClaw's claude-cli backend currently consumes (cross-checked, read-only)

`src/agents/cli-output.ts` (`createCliJsonlStreamingParser`, `parseClaudeCliStreamingDelta`,
`dispatchClaudeCliStreamingToolEvent`, `parseClaudeCliJsonlResult`) and
`src/agents/cli-runner/claude-live-session.ts` (`runClaudeLiveSessionTurn`,
`noteClaudeLiveProgress`) currently consume:

- `stream_event` → only `content_block_delta` with `delta.type === "text_delta"` is turned into an
  assistant streaming delta (`onAssistantDelta`). **`thinking_delta` and `signature_delta` events are
  not extracted** — there is no thinking-stream emission path in this parser today (gap vs. §3).
- `stream_event(content_block_start/delta/stop)` for tool_use/tool_result block types → tool-call
  reconstruction (`onToolUseStart`, `onToolResult`).
- `assistant` / `user` frames → fallback tool_use/tool_result reconstruction from full snapshots
  (covers the case where `--include-partial-messages` is absent).
- `result` → final text (`result.result`, unwrapped via `unwrapNestedCliResultText`), session id
  (`pickCliSessionId`, includes `session_id`/`thread_id`), and usage (`readCliUsage`).
- `system`, `rate_limit_event`, `stream_event(message_start/message_delta/message_stop)` content is
  **not separately parsed** for content lanes — only `readCliUsage` opportunistically pulls usage from
  any frame's `message.usage` / `usage` / `stats` field, so `message_delta.usage` (with
  `thinking_tokens`) is picked up generically.
- `control_request`/`control_response` (not present in these captures, but handled by
  `handleClaudeLiveControlRequest`) → native tool-permission handshake, not a content lane.

## 9. Open questions

- Why did `plain.jsonl` (simple instruction, no "think" wording) produce a thinking block
  (signature-only, empty text, `thinking_tokens: 19`) while `reasoning.jsonl` (explicit
  "think step by step") produced none (`thinking_tokens: 0`)? Sample size is 2; needs a larger
  capture set to determine whether this is effort-level-dependent, model-alias-dependent
  (`claude-fable-5`), or session-state-dependent (the second run reused cached context from the
  first — `cache_read_input_tokens: 8155` in both).
- Since OpenClaw's streaming parser does not extract `thinking_delta`/`signature_delta`, is there a
  separate non-streaming path (e.g. final `assistant` snapshot's `content[].type === "thinking"`)
  that surfaces thinking text when `--include-partial-messages` is used without a custom
  `onAssistantDelta`? Not verified in this pass — `cli-output.ts` does not appear to special-case
  `thinking` blocks in `assistant.message.content` either.
- `result.modelUsage` includes a `claude-haiku-4-5-*` line item in both captures — confirm whether
  this is CLI-side title/summary generation that should be excluded from per-turn cost attribution
  in OpenClaw's usage accounting, or whether it's already filtered upstream.
- Neither capture exercised tool calls, narration/commentary between tool calls, or error frames;
  the §8 mapping for those rows is derived from `cli-output.ts` code reading, not live capture.
