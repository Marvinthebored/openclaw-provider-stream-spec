# F2 Dialect Notes — Cross-Dialect Comparison

_F2 = Chat-Completions-shaped streaming (SSE or JSONL). This document is the reference
for F2 adapter authors: what actually varies across the dialects we hold captures for._

---

## Comparison Table

| Dialect | Reasoning lane (field name(s)) | Reasoning delta granularity | tool_calls arguments form | finish_reason values observed | Usage chunk (present? shape?) | Keepalives / comments | Envelope quirks / extra fields | First-chunk role announcement |
|---|---|---|---|---|---|---|---|---|
| **Pioneer** (claude-opus-4-8) | **none** — no reasoning field in any chunk | n/a | n/a (no tool call capture) | `stop`, `null` | YES — separate trailing chunk with empty `choices:[]`, carries `prompt_tokens`/`completion_tokens`/`total_tokens`; also a preceding empty-delta chunk with `x_pioneer:{inference_id}` | none | **JSONL** (not SSE); extra top-level `x_pioneer:{inference_id}` chunk between finish chunk and usage chunk; no `system_fingerprint` | NO — first chunk goes straight to content delta, no `role` field in delta |
| **OpenRouter / Claude** (anthropic/claude-4.6-sonnet) | `reasoning` (flat string) + `reasoning_details[]` (structured, both populated simultaneously per dual-lane rule) | token-by-token fragments in both lanes; `reasoning_details[]` entries carry `type:"reasoning.text"`, `format:"anthropic-claude-v1"`, `index:0`; signature-only chunk (encrypted base64) emitted as separate detail entry | n/a (no tool call capture) | `stop` (choices), `end_turn` in `native_finish_reason` | YES — on a **second** stop chunk that has `service_tier`, `choices[role only]`, full `usage` with `cost`, `is_byok`, `prompt_tokens_details`, `cost_details`, `completion_tokens_details.reasoning_tokens`; distinct from the `finish_reason:"stop"` chunk | YES — `: OPENROUTER PROCESSING` SSE comments before first data line | SSE; extra `provider` field (e.g. `"Anthropic"`); `native_finish_reason` alongside `finish_reason`; `service_tier` on usage chunk; cost/BYOK fields in usage | YES — role in first data chunk delta (`"role":"assistant"`) alongside first reasoning delta |
| **OpenRouter / GPT-5-mini** (openai/gpt-5-mini) | `reasoning` (flat string) + `reasoning_details[]` (type `"reasoning.summary"`, format `"openai-responses-v1"`) | token-by-token summary fragments in both lanes; summary (not raw CoT) only | n/a (no tool call capture) | `stop` (choices), `completed` in `native_finish_reason` | YES — same double-stop-chunk pattern as OpenRouter/Claude; `completion_tokens_details.reasoning_tokens` present | YES — `: OPENROUTER PROCESSING` SSE comments | SSE; `provider:"OpenAI"`; `native_finish_reason`; cost/BYOK usage fields | YES — role in first data chunk delta, combined with first reasoning+summary delta |
| **OpenRouter / DeepSeek-R1** (deepseek/deepseek-r1 via Novita) | `reasoning` (flat string) + `reasoning_details[]` (type `"reasoning.text"`, format `"unknown"`) | token-by-token fragments; format tag is `"unknown"` (provider not identified by OpenRouter) | n/a (no tool call capture) | `stop` (choices), `stop` in `native_finish_reason` | YES — same double-stop-chunk pattern; `service_tier:null`; `completion_tokens_details.reasoning_tokens` present | YES — `: OPENROUTER PROCESSING` SSE comments | SSE; `provider:"Novita"` (not DeepSeek); `service_tier:null`; cost/BYOK usage fields | YES — role in first data chunk delta combined with first reasoning delta |
| **DeepSeek native** (deepseek-v4-flash) | `reasoning_content` only (flat string; no `reasoning_details[]`) | token-by-token fragments; `content` is `null` during reasoning phase, then `reasoning_content` becomes `null` when content begins | n/a (no tool call capture) | `stop` | YES — **inline** with the stop chunk (same chunk carries `finish_reason:"stop"` and `usage`); shape: `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens` | none | SSE; `system_fingerprint` (long model/infra string); `logprobs:null` in each chunk; no `native_finish_reason` | YES — role in first chunk delta; `content:null` initially (not `""`) |
| **Moonshot / Kimi K2.6** (kimi-k2.6) | `reasoning_content` only (flat string; no `reasoning_details[]`) | token-by-token fragments; content begins only after reasoning ends (mutually exclusive per chunk) | n/a (no tool call capture) | `stop` | YES — **inline** with the stop chunk; shape: `prompt_tokens`, `completion_tokens`, `total_tokens` embedded inside `choices[0].delta` as `usage:{}` (NOT a top-level usage field) | none | SSE; `system_fingerprint`; usage inside delta not at top-level | YES — first chunk has `content:""` in delta with role; reasoning starts in second chunk |
| **Moonshot / moonshot-v1-8k** (base, non-reasoning) | **none** — no reasoning field | n/a | n/a (no tool call capture) | `stop` | YES — **inline** with the stop chunk; `usage` inside `choices[0].delta` (same as Kimi K2.6 pattern) | none | SSE; `system_fingerprint`; usage inside delta | YES — first chunk has `role:"assistant"` and `content:""` in delta |
| **gpt-oss / ollama compat** (gpt-oss:20b, plain) | `reasoning` only (flat string; no `reasoning_details[]`) | token-by-token fragments; `content:""` during reasoning, then `content:"<answer>"` when reasoning ends | n/a (tool call tested separately) | `stop` | **NO** — no usage chunk emitted at all | none | SSE; `system_fingerprint:"fp_ollama"`; no `native_finish_reason`; no `provider` field | YES — role in very first chunk delta, alongside first reasoning delta |
| **gpt-oss / ollama compat-tools** (gpt-oss:20b, tools) | `reasoning` only (same pattern) | token-by-token fragments | **whole JSON string** in single tool_calls chunk: `"arguments":"{\"city\":\"Tokyo\"}"` — delivered as one atomic string, not streamed fragments | `tool_calls` | **NO** — no usage chunk | none | SSE; `system_fingerprint:"fp_ollama"` | YES — role in very first chunk delta |

---

## Per-Dialect Prose Notes

### Pioneer (stream.jsonl, stream-thinking.jsonl)

Pioneer emits **JSONL** not SSE — newline-delimited JSON objects with no `data:` prefix
and no `[DONE]` sentinel. The stream terminates at EOF. The captures show no reasoning
fields at all (even the `stream-thinking.jsonl` capture, which requests thinking, shows
only `content` deltas — this aligns with SPEC §10 item 2: "reasoning field name unknown").
After the `finish_reason:"stop"` chunk, Pioneer emits two extra chunks: one empty-delta
chunk carrying `x_pioneer:{inference_id}` and then one empty-choices chunk carrying
`usage`. A naive OpenAI parser that stops after seeing `finish_reason:"stop"` will miss
the usage frame. The `choices:[]` usage chunk (empty array, not null) will break parsers
that unconditionally index `choices[0]`.

### OpenRouter / Claude (claude-sonnet.sse)

The dual-lane problem is live here: both `delta.reasoning` (flat string) and
`delta.reasoning_details[]` are populated in the same chunks. Per §3.2 dedup rule,
`reasoning_details[]` wins and the flat lane is ignored. The encrypted signature is
delivered as a separate `reasoning_details` entry (no `text` field, only `signature`).
OpenRouter emits the usage on a *second* stop chunk distinct from the first
`finish_reason:"stop"` chunk — the first stop chunk has `"role":"assistant"` in delta
with `reasoning:null` but NO usage. A parser that reads usage only from the first stop
chunk will get nothing.

### OpenRouter / GPT-5-mini (gpt-5-mini.sse)

Uses `reasoning_details[].type:"reasoning.summary"` with `format:"openai-responses-v1"`.
This is the only dialect in our captures that delivers summary-variant reasoning (not raw
CoT). The flat `reasoning` field mirrors the summary text. At the stop chunk,
`reasoning:null` signals end of reasoning. The `native_finish_reason:"completed"` differs
from the canonical `"stop"` — a parser doing equality checks on `finish_reason` for
completion detection works fine, but one checking `native_finish_reason` needs to handle
`"completed"` as equivalent to `"stop"`.

### OpenRouter / DeepSeek-R1 (deepseek-r1.sse)

Same dual-lane (flat + `reasoning_details[]`) as OpenRouter/Claude, but the format tag
inside `reasoning_details[]` is `"unknown"` — OpenRouter cannot identify the upstream
provider's format. `native_finish_reason:"stop"` (lowercase, same as choices). Provider
is `"Novita"`, not `"deepseek"` — routing is opaque. `service_tier:null` (unlike Claude
which gets `"default"`). A parser relying on `provider` to identify model family will
misclassify this as Novita infrastructure, not DeepSeek.

### DeepSeek native (deepseek-reasoner.sse)

Uses `reasoning_content` as the sole reasoning field — no `reasoning_details[]`, no flat
`reasoning`. Critically, during the reasoning phase `content` is the JSON value `null`
(not an empty string `""`). A parser that does `delta.content || ""` will work, but one
that checks `typeof delta.content === "string"` will silently drop reasoning-phase chunks.
The transition from reasoning to answer is signalled by `reasoning_content` becoming
`null` and `content` becoming non-null. Usage arrives **inline** with the stop chunk, not
in a separate chunk. The `system_fingerprint` is a long infra string
(`"fp_8b330d02d0_prod0820_fp8_kvcache_20260402"`), not a short hash.

### Moonshot / Kimi K2.6 (kimi-k2.6.sse)

Uses `reasoning_content` (same field as DeepSeek native). The critical divergence from
all other dialects: **usage is nested inside `choices[0].delta`** on the stop chunk, not
at the top-level. The stop chunk shape is:
`choices:[{delta:{}, finish_reason:"stop", usage:{prompt_tokens, completion_tokens, total_tokens}}]`.
A parser that reads `chunk.usage` will find nothing; it must read `chunk.choices[0].delta.usage`.
No reasoning_tokens breakdown in the usage field (unlike DeepSeek native which provides
`completion_tokens_details.reasoning_tokens`). First chunk announces role with `content:""`
(empty string, not null — differs from DeepSeek native's `content:null`).

### Moonshot / moonshot-v1-8k (moonshot-v1-8k.sse)

Non-reasoning base model. Same usage-in-delta-stop-chunk quirk as Kimi K2.6. Only three
chunks total: role announcement, content delta, stop+usage. Minimal and clean otherwise.

### gpt-oss / ollama compat plain (openai-compat.sse)

Uses flat `reasoning` field only — no `reasoning_details[]`. Unlike OpenRouter which
also emits `reasoning`, here it is the authoritative source (single lane). The content
and reasoning fields co-exist in every chunk: `content:""` (empty string) during reasoning
phase, then `content:"391"` when reasoning ends. **No usage chunk is emitted at all** —
ollama's OpenAI-compat surface omits it entirely. Parsers that treat absence of usage as
an error will break. No `native_finish_reason`, no `provider`, no cost fields.

### gpt-oss / ollama compat-tools (openai-compat-tools.sse)

Same reasoning pattern as plain compat. Tool calls are delivered in a **single atomic
chunk** with `finish_reason:"tool_calls"` — all argument content arrives in one chunk as
a pre-assembled JSON string (`"arguments":"{\"city\":\"Tokyo\"}"`), not as streamed
argument fragments. This means the adapter must NOT wait for an argument-accumulation
loop — the complete call is in one delta. No usage chunk. Note: SPEC §10 item 4 flags
that the **ollama native** envelope (not captured here) uses object-form arguments
(`arguments: {...}` not a string) — that is a different surface from this compat capture.

---

## Probe Order Validation

SPEC §6 (thinking-raw row) says "sibling reasoning fields (probe order per evidence)"
and defers the canonical ordering to evidence. SPEC §10 item 2 says the reasoning field
name for Pioneer is "unknown (4 candidates; §3.2 probe order + dedup covers all)." The
four candidates implied are: `reasoning_details[]`, `reasoning_content`, `reasoning`,
`reasoning_text`.

Evidence from these captures:

| Field | Dialects that use it |
|---|---|
| `reasoning_details[]` | OpenRouter (all three: Claude, GPT-5-mini, DeepSeek-R1) — always co-present with flat `reasoning` |
| `reasoning_content` | DeepSeek native, Moonshot Kimi K2.6 — sole field |
| `reasoning` | OpenRouter (co-present with `reasoning_details[]`), gpt-oss/ollama compat — sole field in ollama case |
| `reasoning_text` | **Not observed in any capture** |

The correct probe order for a single-pass adapter is:

1. **`reasoning_details[]`** — check first; when present, apply §3.2 dedup (structured wins, flat `reasoning` ignored).
2. **`reasoning_content`** — DeepSeek native and Moonshot; sole field, no dedup needed.
3. **`reasoning`** — ollama/gpt-oss compat when no `reasoning_details[]` present.
4. **`reasoning_text`** — not yet observed; retain as fallback per SPEC.

This probe order is **consistent with** SPEC §3.2's stated order
(`reasoning_details[]` first, then `reasoning_content`, `reasoning`, `reasoning_text`).

**Pioneer** (the one dialect whose reasoning field name was flagged as unknown) shows
**no reasoning field at all** in either capture — even `stream-thinking.jsonl`. The
probe-order concern for Pioneer is unresolved by these captures; the four-candidate
fallback chain still applies speculatively.

---

## CONTRADICTS-SPEC

The following observations are in tension with or are not fully covered by SPEC §6 F2
rows or §3.2:

1. **Moonshot usage-in-delta**: SPEC §6 usage row says "final usage chunk (when offered)
   → lifecycle." The Moonshot dialects (kimi-k2.6.sse, moonshot-v1-8k.sse) embed usage
   inside `choices[0].delta` on the stop chunk, not as a top-level `usage` field. SPEC
   does not document this variant — a conforming adapter reading `chunk.usage` will miss
   Moonshot usage entirely.

2. **Pioneer JSONL + extra chunks after stop**: SPEC §6 session/setup row says
   `[DONE]` is "transport-only, consumed." Pioneer has no `[DONE]`; termination is
   EOF. SPEC does not mention the `x_pioneer` chunk or the empty-`choices[]` usage
   chunk that follows `finish_reason:"stop"`. An adapter that stops consuming after
   the first `finish_reason:"stop"` chunk will miss Pioneer usage.

3. **DeepSeek `content:null` during reasoning**: SPEC §6 does not note that
   `delta.content` can be JSON `null` (vs. absent or `""`) during the reasoning phase.
   Adapters that normalize `content` as a string without null-checking will mishandle
   DeepSeek native.

4. **`reasoning_text` not observed**: SPEC §3.2 probe order includes `reasoning_text` as
   a candidate. No capture shows it. It may be a future-proofing placeholder or a
   field name from a provider not yet captured — it is not contradicted, merely absent
   from evidence.
