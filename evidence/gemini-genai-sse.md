# Google Gemini genai SSE (F5) — provider stream catalogue

Status: draft | Date: 2026-06-12 | Agent: Doc (claude-sonnet-4-6)

## 1. Sources

- **Docs:** https://ai.google.dev/api/generate-content#streamgeneratecontent (accessed 2026-06-12);
  https://ai.google.dev/gemini-api/docs/thinking (thinkingConfig and thoughtSignature);
  https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/send-multimodal-prompts#gemini-send-multimodal-samples-drest (Vertex alt)
- **Captures (primary ground truth):**
  - `captures/gemini/gemini-2.5-flash-thinking.sse` — basic thinking, 3 SSE frames; command: `curl -N -H "x-goog-api-key: REDACTED" "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse" -d '{"contents":[...],"generationConfig":{"thinkingConfig":{"includeThoughts":true}}}' 2>/dev/null`
  - `captures/gemini/gemini-2.5-flash-thinking-long.sse` — longer thinking (budget 512), 6 SSE frames; same command with more complex prompt
  - `captures/gemini/gemini-2.5-flash-tool-thinking.sse` — function call + thinking, 2 SSE frames; same pattern with tools defined

## 2. Frame inventory

| Frame/event type | Key fields | Semantics | Source |
|---|---|---|---|
| **Thinking chunk** | `candidates[0].content.parts[{text, thought:true}]`, `usageMetadata.thoughtsTokenCount` | Incremental chain-of-thought reasoning; `thought: true` is the discriminator. No `finishReason`. Multiple frames possible. | All three captures |
| **Text chunk** | `candidates[0].content.parts[{text}]` (no `thought` field), `usageMetadata.candidatesTokenCount` | Incremental final-answer text. One or more frames, last carries `finishReason`. | thinking-long.sse frames 4–6, thinking.sse frame 3 |
| **Function-call chunk** | `candidates[0].content.parts[{functionCall:{name, args}, thoughtSignature}]`, `finishReason:"STOP"`, `finishMessage` | Tool invocation; `thoughtSignature` is the opaque continuation blob (base64). Single frame, terminal. | tool-thinking.sse frame 2 |
| **Terminal (STOP) frame** | `finishReason:"STOP"` on last candidate | Clean end of turn; may coincide with a text or function-call part in the same chunk. | All captures |
| **usageMetadata frame** | `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`, `promptTokensDetails[{modality,tokenCount}]`, `serviceTier` | Usage statistics; present on every chunk in captures (cumulative running total). | All three captures |
| **modelVersion / responseId** | `modelVersion:"gemini-2.5-flash"`, `responseId` | Top-level turn identity fields present on every chunk. | All three captures |
| **finishReason:MAX_TOKENS** | `finishReason:"MAX_TOKENS"` | Token budget exhausted — doc-only, not seen in captures. Maps to Truncate path. | Docs only |
| **finishReason:SAFETY** | `finishReason:"SAFETY"`, `safetyRatings[{category,probability,blocked:true}]` | Safety block — doc-only, not seen in captures. Maps to Reject path. | Docs only |
| **finishReason:RECITATION** | `finishReason:"RECITATION"`, `citationMetadata` | Copyright recitation block — doc-only. Maps to Reject path. | Docs only |
| **finishReason:OTHER** | `finishReason:"OTHER"` | Unspecified stop — doc-only. Maps to `lifecycle/end status:"incomplete"`, no final_answer. | Docs only |
| **safetyRatings** | `candidates[0].safetyRatings[{category,probability}]` | Per-candidate safety signal; present even when not blocked — doc-only, not in captures. | Docs only |
| **citationMetadata** | `candidates[0].citationMetadata.citationSources[]` | Source citations — doc-only, not in captures. | Docs only |
| **finishMessage** | `candidates[0].finishMessage` | Human-readable stop description; seen in tool capture: `"Model generated function call(s)."` | tool-thinking.sse frame 2 |

**Field inventory across all three captures:**

Top-level keys observed: `candidates`, `usageMetadata`, `modelVersion`, `responseId`

`candidates[0]` keys observed: `content` (always), `index` (always, value `0`), `finishReason` (terminal frames only), `finishMessage` (tool frame only)

`content` keys: `parts` (array), `role` (`"model"` always)

`parts[]` keys observed: `text`, `thought` (thinking parts only), `functionCall` (tool frame), `thoughtSignature` (tool frame only, on the `functionCall` part)

`usageMetadata` keys observed: `promptTokenCount`, `totalTokenCount`, `promptTokensDetails`, `thoughtsTokenCount`, `serviceTier`; `candidatesTokenCount` appears only on frames with text answer content (absent on pure-thinking frames)

## 3. Content lanes

- **Final answer text:** `parts[].text` on chunks where `thought` is absent (or `false`). Streams as incremental deltas across multiple chunks. The last chunk carries `finishReason:"STOP"` and the final fragment of text. No separate "this is the last text" field — finality is signalled by `finishReason` on the candidate, not by a field on the part.

- **Thinking/reasoning:** `parts[].text` with `thought: true`. Observed as raw CoT (variant: `raw`). Always precedes the text answer in captures. No summary or redacted variant observed in captures; summary and redacted doc-only. `thoughtsTokenCount` in `usageMetadata` tracks accumulated thinking token spend (cumulative, updated each chunk).

- **Narration/commentary/preamble:** Not a distinct lane in F5. Gemini does not emit a separate "visible interim text before tool calls" lane. Inter-tool narration (if any) would appear as a text chunk without `thought:true` before a `functionCall` part; not observed in captures. Doc-only claim: treat pre-tool plain text as commentary (same as final text but followed by a tool frame).

- **Tool calls + results:** `parts[{functionCall:{name, args}}]` with `thoughtSignature` attached. Only the call is streamed; the result (tool response) is sent by the client in the next turn's `contents[]`, not streamed back. Single chunk per turn in captures.

- **Usage/metadata:** `usageMetadata` on every SSE chunk, cumulative. `thoughtsTokenCount` tracks reasoning tokens. `candidatesTokenCount` tracks output tokens. Both present on final frame; `candidatesTokenCount` absent on pure-thinking chunks.

- **Errors:** Not observed in captures. Docs describe `finishReason:"SAFETY"/"RECITATION"` with `safetyRatings`/`citationMetadata`. No in-band error object field documented for streaming chunks (unlike OpenRouter F2 dialect). Stream death with no terminal frame should be treated as `stream_closed`.

## 4. Ordering & interleaving guarantees

Observed ordering in all captures: **all thinking chunks complete before any text chunk begins.** No interleaving of `thought:true` and plain-text parts across chunks in any capture.

Within a single chunk, `parts[]` can contain multiple entries (not observed in captures — every chunk had exactly one part). Doc says multiple parts are possible; ordering within `parts[]` is sequential.

`finishReason` appears only on the final chunk and only on the candidate, never on a part.

`thoughtSignature` is attached to the `functionCall` part, not a standalone frame or top-level field.

No sequence index or block index is provided on parts or chunks (unlike F1/F3). Ordering is purely arrival order of SSE frames. Adapters must not assume provider-side re-ordering.

Multiple candidates (`index > 0`) are doc-supported (`n>1` setting) but all captures have exactly one candidate at index 0.

## 5. Delta vs snapshot semantics

All content frames are **deltas** — each `text` value is a fragment to append, not a full snapshot. There is no snapshot or accumulated-text field on the wire (unlike F3's `text` accumulation on `response.output_item.text`). Adapters must concatenate across chunks.

`usageMetadata` is a **running snapshot** — token counts are cumulative and the latest frame's values supersede earlier ones.

`thoughtsTokenCount` in `usageMetadata` is cumulative across all thinking chunks, not per-chunk. The final total is on the last chunk.

There is no chunk sequence number or index — reassembly is by SSE arrival order only.

## 6. Termination & final-frame semantics

Turn ends when a chunk carries `candidates[0].finishReason` with a non-null value. Observed values: `"STOP"`. The final answer text (or function call) may be co-present in the same chunk as `finishReason`.

For text responses: the last text delta and `finishReason:"STOP"` arrive in the same chunk. There is no separate empty terminal chunk. The adapter must re-tag the accumulated text as `phase:"final_answer"` upon seeing the STOP.

For function-call responses: `finishReason:"STOP"` and `finishMessage:"Model generated function call(s)."` appear in the same chunk as the `functionCall` part. No trailing text chunk follows.

There is no `[DONE]` sentinel (unlike OpenAI F2). The SSE stream closes after the final `data:` line.

`thoughtSignature` is emitted on the **same chunk** as the `functionCall` part (observed: tool-thinking.sse frame 2). It is NOT a trailing frame. It is attached directly to the part object alongside `functionCall`.

## 7. Observed dialect deviations

**a. Aggregator re-exposure (OpenRouter etc.):** OpenRouter and similar aggregators do not expose F5 natively. They re-expose Gemini through their F2 (OpenAI Chat Completions SSE) dialect, with thinking content surfaced via their `reasoning` / `reasoning_details[]` fields, consistent with their general reasoning-model treatment. F5-native wire format is only seen on direct Google AI API calls (`generativelanguage.googleapis.com`) or Vertex AI. Adapters receiving Gemini through OpenRouter should use the OpenRouter/F2 dialect rules (`openrouter-dialect.md`), not F5 rules.

**b. Antigravity CLI transport:** A CLI transport for Gemini ("antigravity CLI") is known to exist but is NOT testable on this machine (no credentials, no binary confirmed). Its wire format is an open question — it may be F5-native, may be a JSONL envelope over F5 (analogous to F1e over F1), or may differ substantially. **Do not assume F5 field shapes apply; flag as untested transport.** See §9.

**c. `thoughtSignature` field placement:** `thoughtSignature` is a sibling of `functionCall` inside a `parts[]` entry (i.e., the part object has both `functionCall` and `thoughtSignature` keys). It is NOT a top-level chunk field, NOT a separate part, and NOT a trailing chunk. This placement is consistent with Google's documented role: it binds the opaque continuation state to the specific function call part that carries it. The value is a long base64 string (observed: 344 chars in tool-thinking.sse). This is Gemini's equivalent of Anthropic's `thinking` block `signature` (F1) — opaque, model-internal, required for API replay continuations. **Must be stored in the adapter transcript only; must never be emitted as a bus event.**

**d. `candidatesTokenCount` absent on thinking-only chunks:** In all three captures, chunks containing only `thought:true` parts have no `candidatesTokenCount` in `usageMetadata`. It appears only on chunks that carry answer text or function-call parts. Adapters must not assume `candidatesTokenCount` is present on every chunk.

**e. `finishReason` on thinking frames:** Thinking chunks have no `finishReason` field on the candidate. It is absent, not null. Do not confuse absence with `"UNSPECIFIED"`.

**f. `usageMetadata` on every chunk:** Unlike some providers that emit usage only on the final frame, Gemini emits `usageMetadata` on every SSE chunk with cumulative running totals. The last chunk's totals are authoritative.

**g. No `[DONE]` sentinel:** SSE stream terminates by closing the connection, not by a `data: [DONE]` line.

## 8. Proposed normalization

Mapping to OpenClaw streams per `reference/agent-event-io-contract-f92c1bf.md`. Coverage is total over §2.

| F5 wire signal | OpenClaw stream | phase / variant | data fields | Notes |
|---|---|---|---|---|
| `parts[{text, thought:true}]` chunk | `thinking` | `variant:"raw"` | `delta: part.text` | Emit unconditionally (SPEC §3.2). Never drop even when display is off. |
| `parts[{text}]` chunk (no `thought`), no `finishReason` yet | `assistant` | `phase:"commentary"` | `delta: part.text` | Pre-final text; treat as narration/commentary until STOP is confirmed. If followed immediately by a tool call in the same turn (doc-only pattern), re-classify retrospectively as commentary. |
| `parts[{text}]` chunk with `finishReason:"STOP"` | `assistant` | `phase:"final_answer"` | `delta: part.text`, `status:"completed"` | Re-tag final text fragment. Accumulated text is the full answer. |
| `parts[{functionCall:{name,args}}]` with `finishReason:"STOP"` | `tool` / `item` | `phase:"start"` then `phase:"end"` after execution | `kind:"tool"`, `name: functionCall.name`, `meta: JSON.stringify(functionCall.args)`, `toolCallId: responseId+partIndex` | `thoughtSignature` is stripped here — adapter transcript only, never on bus. Emit `start` immediately; `end` after tool result is returned by client. |
| `finishReason:"MAX_TOKENS"` (doc-only) | `assistant` (re-tag), then `lifecycle` | `phase:"final_answer"` + `truncated:true`; lifecycle `phase:"end"` | `status:"incomplete"`, `reason:"truncated"` | Truncate path per SPEC §3.5. |
| `finishReason:"SAFETY"` (doc-only) | `lifecycle` | `phase:"error"` | `reason:"content_filter"` | Reject path. Any partial text emitted as commentary must be retracted by channel. No `final_answer`. |
| `finishReason:"RECITATION"` (doc-only) | `lifecycle` | `phase:"error"` | `reason:"content_filter"` | Same Reject path as SAFETY. `citationMetadata` goes to adapter transcript only. |
| `finishReason:"OTHER"` (doc-only) | `lifecycle` | `phase:"end"` | `status:"incomplete"`, `reason:"unknown"` | Conservative: no `final_answer`. |
| `finishReason:"STOP"` with `functionCall` part | `lifecycle` | `phase:"update"` | `reason:"tool_use"` | Turn yields to tool execution; no `final_answer`; loop continues. |
| `finishReason:"STOP"` with no pending text (zero-text finalize) | `lifecycle` | `phase:"end"` | `status:"completed"` | No `final_answer` event (SPEC §3.5 zero-text rule). |
| `usageMetadata` (every chunk, cumulative) | `lifecycle` | `phase:"end"` (final only) | `usage: {promptTokens, candidatesTokens, thoughtsTokens, totalTokens}` | Emit once at turn end with final cumulative values. Do NOT emit a lifecycle event per chunk. |
| Stream closes with no `finishReason` ever | `lifecycle` | `phase:"error"` | `reason:"stream_closed"` | SPEC §3.4 stream-death rule. |
| `thoughtSignature` (on `functionCall` part) | **Not a bus event** | — | — | Adapter transcript only (SPEC §2). Opaque continuation blob. Strip before any event emission. |
| `safetyRatings` (doc-only, per candidate) | **Not a bus event** | — | — | Adapter transcript only unless `blocked:true`, which surfaces via `finishReason:"SAFETY"`. |
| `citationMetadata` (doc-only) | **Not a bus event** | — | — | Adapter transcript only. |
| `modelVersion`, `responseId` | `lifecycle` | `phase:"start"` | `model: modelVersion`, `id: responseId` | Emit once at turn start when first chunk arrives. |
| `finishMessage` (e.g., "Model generated function call(s).") | **Drop** | — | — | Informational; no normalized equivalent. |

## 9. Open questions

1. **Antigravity CLI transport format:** A Gemini CLI transport is known but not testable on this machine. Unknown whether it is F5-native SSE, a JSONL envelope (analogous to F1e), or a different protocol entirely. Needs a capture before an F5-vs-Fgemini-cli split decision can be made.

2. **`thoughtSignature` in non-tool thinking turns:** In the two non-tool thinking captures, no `thoughtSignature` field appears anywhere. The tool capture shows it only on the `functionCall` part. Open question: does `thoughtSignature` ever appear on text-answer parts (e.g., for multi-turn continuations that need prior-turn thinking state)? Not observable from current captures — doc-only claim pending live capture.

3. **Multi-part chunks:** All observed chunks contain exactly one part. The API allows `parts[]` to contain multiple entries (e.g., mixed text + functionCall in one chunk). No capture of this pattern. Normalization rule for multi-part chunks: emit events in `parts[]` order, using `parts` index as local ordering tie-breaker within the chunk.

4. **`finishReason:"STOP"` with `functionCall` AND trailing text in same chunk:** Not observed. If it occurs, the function-call part takes semantic precedence (turn yields to tool); text part is commentary.

5. **Safety-block mid-stream (partial text already streamed):** Not captured. Per SPEC §3.5 Reject path, channels must retract partial text on `SAFETY`/`RECITATION`. F5 does not appear to have a mid-stream safety signal separate from the terminal `finishReason` — needs confirmation that a SAFETY stop always arrives as the terminal frame (not mid-stream).

6. **Vertex AI dialect:** Vertex AI exposes `streamGenerateContent` at a different base URL. Fields are documented as identical to Google AI API, but `serviceTier` and `responseId` may differ. No Vertex capture available.

7. **`thoughtsTokenCount` when thinking is disabled:** In non-thinking turns, is `thoughtsTokenCount` absent or `0`? Not testable from current captures (all three have thinking enabled). Adapters should treat absent and `0` identically.

8. **`finishReason:"MALFORMED_FUNCTION_CALL"`:** Documented by Google but not in captures. Would map to `lifecycle/error reason:"tool_error"`.
