# Red-team findings: SPEC.md adversarial review

**Reviewer:** Codex (GPT-5), fresh-context adversarial  
**Date:** 2026-06-12  
**Brief:** RED-TEAM-BRIEF.md  
**Spec under review:** SPEC.md v0.2-draft  
**Ground truth:** evidence/*.md, reference/agent-event-io-contract-f92c1bf.md  
**Prior pass checked:** RED-TEAM-claude.md; findings below avoid re-stating the 27 v0.1 issues already folded into v0.2.

---

## Verification notes on v0.2 fixes

- The three explicit **[AMENDS BASE]** markers are present at §3.3, §5.1, and §7.3.
- The prior Claude blockers around refusal finalization, `pause_turn`, stream death, and hidden thinking mirror are addressed textually.
- However, v0.2 introduces or leaves the fresh failures below, especially around §3.5 reject/truncate dispatch, §6 totality, and one unmarked base-contract amendment in §3.2.

---

## Attack Surface 1: Mapping totality

### COD-AS1-01 · MAJOR · §6 F3 Responses totality

**Failure scenario.** SPEC §6 marks F3 `content_part.*` as "Phase-1 out of scope" with an `unsupported_frame` diagnostic, while also saying those frames are "consumed for indexing only." This is contradictory and wrong for ordinary Responses streams. The F3 evidence catalogues `response.content_part.added` / `.done` as normal structural events for `output_text`, `refusal`, and `reasoning_text` parts; the proposed normalization says output-text `content_part.added` is metadata only, with no standalone bus event. If v0.2 is implemented literally, every normal Responses text/refusal/reasoning stream emits `unsupported_frame` diagnostics for supported framing events.

**Evidence.** `evidence/openai-families.md` §B.2 (`response.content_part.added` / `.done` inventory), §B.8 (`content_part.added` establishes `content_index`; no event needed standalone). SPEC §6 "Phase-1 out of scope" row.

**Fix.** Split this row. `content_part.*` for supported part types (`output_text`, `refusal`, `reasoning_text`) should be "structural/indexing only, no bus event, no diagnostic." Only truly unsupported part types should emit `unsupported_frame`.

---

### COD-AS1-02 · MAJOR · §6 F2 thinking summary

**Failure scenario.** SPEC §3.2 correctly names OpenRouter summary entries as `reasoning_details[type=reasoning.summary]`, but §6's F2 summary row says `reasoning_details[type=summary]`. The evidence uses the full type string `reasoning.summary`. An implementer building from §6 will not match real OpenRouter summary frames and will either drop them or raise `unknown_frame` / `unsupported_frame`.

**Evidence.** `evidence/openrouter-dialect.md` §2 and §3 list the structured types as `reasoning.text`, `reasoning.summary`, and `reasoning.encrypted`. SPEC §3.2 uses `reasoning.summary`; SPEC §6 does not.

**Fix.** Change §6 F2 summary cell to `reasoning_details[type=reasoning.summary]`.

---

### COD-AS1-03 · MAJOR · §6 F1 lifecycle/control frames

**Failure scenario.** SPEC §6 has no F1 disposition for `message_start` or `message_stop`; the `session/setup frames` row is `—` for F1. The F1 catalogue's §2 inventory includes both as mandatory frames. This breaks the §8 totality claim and also undermines §7.3 crash recovery, which depends on archived lifecycle start/terminal events.

**Evidence.** `evidence/anthropic-messages-sse.md` §2 lists `message_start` as the first event and `message_stop` as the final event; §8 maps them to lifecycle start/end. SPEC §6 omits them for F1.

**Fix.** Add F1 §6 rows: `message_start` → `lifecycle/start` with provider/model/message metadata; `message_stop` → `lifecycle/end` after the §3.5 terminal dispatch is resolved.

---

### COD-AS1-04 · MAJOR · §6 F1 server-tool result blocks

**Failure scenario.** SPEC §6 maps F1 `tool_use` / `server_tool_use` blocks to item start/update/end, but it does not map server-tool result content blocks such as `web_search_tool_result` / `web_fetch_tool_result` / other `*_tool_result` snapshots. Those result blocks are catalogued in the F1 evidence and are the normal completion signal for Anthropic server tools. A server-side web search stream therefore has no §6 disposition for the result block.

**Evidence.** `evidence/anthropic-messages-sse.md` §3 describes server-tool result blocks as snapshot content blocks; §8 maps `content_block_start`/`stop` for `web_search_tool_result`, `web_fetch_tool_result`, `*_tool_result`, etc. to `item` end/completed. SPEC §6 only names `tool_use` / `server_tool_use`.

**Fix.** Add a F1 result-block row: `*_tool_result` / known server-tool result blocks → `item` update/end for the owning `tool_use_id`, with display-safe summary only.

---

### COD-AS1-05 · MAJOR · §6 F2 metadata/control fields

**Failure scenario.** The §6 F2 column does not dispose of several catalogued normal Chat-Completions/OpenRouter fields: `choices[].delta.role`, `choices[].logprobs`, the `[DONE]` sentinel, OpenRouter `native_finish_reason`, and optional `openrouter_metadata`. Some are transport-only, some are lifecycle/debug metadata, but §6 does not say which. With "Unknown frames: never silently dropped," a conforming adapter has no way to avoid spurious diagnostics on ordinary streams.

**Evidence.** `evidence/openai-families.md` §A.2 lists `delta.role`, `logprobs`, usage chunks, and `[DONE]`; `evidence/openrouter-dialect.md` §2 lists `native_finish_reason`, `openrouter_metadata`, keepalive comments, `[DONE]`, and error frames. SPEC §6 lacks dispositions for these metadata/control fields except comments and usage.

**Fix.** Add an explicit F2 metadata/control row: `delta.role` → lifecycle/start-or-drop; `logprobs` → transcript/debug metadata or unsupported if out of scope; `[DONE]` → transport-only consumed; `native_finish_reason` and `openrouter_metadata` → lifecycle diagnostic/metadata.

---

## Attack Surface 2: Finality algorithm (§3.5)

### COD-AS2-01 · BLOCKER · §3.5 + §4.3

**Failure scenario.** v0.2 prevents F1 `refusal` / F2 `content_filter` partial text from being re-tagged as `final_answer`, but it still lets the same partial text stream into the live draft before the terminal safety stop is known. §3.5 says `Open → Text` "streams as commentary"; §4.3 says `assistant` commentary/deltas are always streamed into the transient draft; §5.1 mirrors progress to channel subscribers. When the later Reject path arrives, SPEC says "partial text remains commentary in archive only," but by then it has already been displayed unless the channel explicitly retracts/redacts it. No such retraction rule exists.

**Evidence.** `evidence/anthropic-messages-sse.md` §6 says `stop_reason:"refusal"` means streaming safety classifiers intervened and partial content is non-final/unsafe to surface as a normal answer. SPEC §3.5 Reject path and §4.3 commentary row conflict with that in live projection.

**Fix.** Reject must be a destructive settle for the affected draft segment: channels MUST replace/remove any already-rendered text for that segment with an error/redacted placeholder. Alternatively, adapters must buffer provider text until the terminal reason is known for providers whose safety stop can retroactively invalidate partial text.

---

### COD-AS2-02 · BLOCKER · §3.5 dispatch table

**Failure scenario.** SPEC maps all F3 `response.incomplete` terminal frames to **Truncate** "same treatment as F1 `max_tokens`." But F3 `response.incomplete` covers both token-limit and content-filter early termination via `response.incomplete_details.reason`. If an F3 stream ends incomplete because of content filtering, v0.2 re-tags the last text segment as `final_answer` with `truncated:true`, which is the same unsafe finalization class v0.2 fixed for F2 `content_filter`.

**Evidence.** `evidence/openai-families.md` §B.2 defines `response.incomplete` with `incomplete_details.reason`; §B.6 says early/truncated termination includes token limit and content filter. SPEC §3.5 maps `F3 response.incomplete (token limit)` unconditionally to Truncate.

**Fix.** Dispatch on `response.incomplete.response.incomplete_details.reason`: token/max-output reasons → Truncate; content-filter/safety reasons → Reject; unknown reasons → lifecycle end/error with no `final_answer` unless explicitly classified.

---

### COD-AS2-03 · MAJOR · §3.5 + §6 F1e final answer

**Failure scenario.** F1e now has two competing final-answer sources. The inner `stream_event(message_delta/message_stop)` follows the F1 finality path, while §6 says F1e final answer is "`result.result` authoritative + §3.5." The CLI evidence says `result.result` is the authoritative final text and the inner assistant/text stream is redundant live progress. Without a normative "one source wins" rule, an adapter can deliver the inner F1 finalized text and then deliver `result.result` again via the final-reply path.

**Evidence.** `evidence/claude-cli-streamjson.md` §2 lists both inner F1 `stream_event` frames and the terminal `result`; §6 says the final answer is in the last assistant text block and independently restated in `result.result`; §8 says OpenClaw's parser uses `result.result` as authoritative and `stream_event` deltas for live progress. SPEC §6 combines `result.result` with §3.5 but does not suppress one path.

**Fix.** For F1e, declare exactly one final source. Recommended: inner F1 text deltas are live draft/progress only, `result.result` is the single authoritative final-reply source; `result.result` is fallback only if no usable streamed text exists.

---

### COD-AS2-04 · MAJOR · §3.5 dispatch table

**Failure scenario.** F2 legacy `finish_reason:"function_call"` is catalogued as the single-function-call predecessor/equivalent of `tool_calls`, but §3.5 dispatch only names F2 `tool_calls`. A legacy-compatible Chat Completions stream with `finish_reason:"function_call"` falls through the "total over all catalogued stop signals" table. If treated as a clean stop, OpenClaw may finalize a tool-call-only turn as an answer; if treated as unknown, it emits a diagnostic for a catalogued stop signal.

**Evidence.** `evidence/openai-families.md` §A.2 lists `finish_reason: "function_call"`; §A.6 calls it the legacy single-function-call equivalent of `"tool_calls"`. SPEC §3.5 only names F2 `tool_calls`.

**Fix.** Add `F2 function_call` to the tool-yield row with the same "no final_answer; runtime tool execution continues" disposition as `tool_calls`.

---

## Attack Surface 3: Truth table (§4.3)

### COD-AS3-01 · MAJOR · §4.3 + §11

**Failure scenario.** v0.2 defines `liveness indicator`, but the truth table and glossary still contradict each other for Tier A `/verbose off` tool-only turns. §4.3 says `item` events with `/verbose off` render a liveness indicator. §11 says Tier A liveness is "the draft exists and is edited (even with no tool rows)" and must not be absent. But the degenerate-draft rule says a draft is created lazily on the first event that would render into it, and with `/verbose off` no tool row content is rendered. The spec therefore requires a draft to exist while also providing no concrete content that creates/edits it.

**Evidence.** `evidence/openclaw-internals.md` §3 confirms Discord's progress UX is an edited draft message, not a separate native liveness API. The base contract's "User promise" requires "agent is working" to be backed by runtime events. SPEC §4.3 and §11 do not specify a non-empty Tier A liveness payload.

**Fix.** Define a concrete Tier A liveness row, e.g. a minimal status line such as `Working...` / spinner driven by item/lifecycle events, and state whether it is dismissed or collapsed at settle. Do not define liveness as an empty draft.

---

## Attack Surface 4: Idempotency/ordering (§7.3)

### COD-AS4-01 · MAJOR · §3.1 + §7.3

**Failure scenario.** SPEC says F3 `item_id` is a stable text-segment `id`, and §7.3 then prefers `runId + id` for F3 idempotency. But Responses text and reasoning are keyed by `item_id` plus `content_index` or `summary_index`; one `message` or `reasoning` item can have multiple content/summary parts. Using only `item_id` collapses distinct segments, causing draft replacement, reconnect deduplication, and final-answer replacement to merge or overwrite content parts that should remain separate.

**Evidence.** `evidence/openai-families.md` §B.2 defines `content_index` and `summary_index`; §B.5 says deltas must be accumulated per `(item_id, content_index)` or `(item_id, summary_index)`. SPEC §3.1 names F3 `item_id` as the stable id and §7.3 uses `runId + id`.

**Fix.** Define F3 segment ids as composite keys: text/refusal `item_id:content_index`; raw reasoning `item_id:content_index`; summary `item_id:summary_index`; item-level lifecycle still uses `item_id`.

---

### COD-AS4-02 · NIT · §7.3

**Failure scenario.** §7.3 says "After `lifecycle` end, no progress replay (§5.6)," but SPEC has no §5.6 heading. The intended target is §5 list item 6.

**Evidence.** SPEC §5 has numbered list item 6 but no subsection §5.6.

**Fix.** Change the reference to "§5 item 6" or create an actual §5.6 heading.

---

## Attack Surface 5: Privacy/security

### COD-AS5-01 · MAJOR · §2 + §3.2 + §6

**Failure scenario.** SPEC correctly keeps F1 `signature_delta`, F3 `encrypted_content`, and OpenRouter `reasoning_details[].data` in adapter-native transcript only, but it does not cover OpenRouter `reasoning_details[].signature` on `reasoning.text` entries. OpenRouter can carry Anthropic-style cryptographic signatures inside a displayable `reasoning.text` object. If an adapter emits the structured entry wholesale as a `thinking` event or archives its metadata, provider continuation signatures leak into the gateway archive, contradicting §2's "opaque material never leaves" rule.

**Evidence.** `evidence/openrouter-dialect.md` §3: `reasoning.text` entries may include `signature`, carrying provider cryptographic signatures. SPEC §2 lists OpenRouter `reasoning_details[].data` but not `.signature`; SPEC §3.2 only names F1 `signature_delta`.

**Fix.** Add OpenRouter `reasoning_details[].signature` to the adapter-native transcript-only list. Normalized `thinking` events may include displayable text/variant/id, but never signature/data/encrypted continuation material.

---

## Attack Surface 6: Coherence with the base contract

### COD-AS6-01 · MAJOR · §3.2 + header

**Failure scenario.** The header says there are exactly three base-contract amendments (§3.3, §5.1, §7.3) and everything else is additive. But §3.2 is also a base-contract amendment: it changes provider reasoning from "stream `thinking` or drop unless explicitly configured" into unconditional emission and archive/mirror of any wire-carried reasoning. That is a semantic tightening of the provider input contract, not an additive detail.

**Evidence.** `reference/agent-event-io-contract-f92c1bf.md` Provider mapping guide says Claude/Anthropic thinking and Harmony analysis map to `thinking` "or drop" unless reasoning display is explicitly configured; the Security section says never send private reasoning to external channels as commentary. SPEC §3.2 says "Emission is unconditional whenever the wire carries reasoning content" and removes `streamReasoning` / `emitReasoning` gates.

**Fix.** Mark §3.2 **[AMENDS BASE]** and update the header count, or revise §3.2 to stay additive by permitting adapter-side drop where the base contract permits it. If the intended design is "emit always," the base contract doc itself must be amended.

---

## Attack Surface 7: Mechanical answerability

### COD-AS7-01 · MAJOR · §3.2

**Failure scenario.** Query: "OpenRouter F2, `/reasoning on`, Tier A, frame contains flat `delta.reasoning`, plus `reasoning_details[]` with a `reasoning.text` entry and a `reasoning.encrypted` entry; ids may be null, indexes may or may not match. What exactly does the bus emit?" v0.2 says structured wins over flat, and encrypted is suppressed when a displayable entry exists for "the same segment." It never defines the segment identity key for `reasoning_details[]`. OpenRouter's own evidence says `index` semantics are under-specified and need capture verification. An implementer cannot mechanically decide whether to emit raw only, redacted only, both, or one per `(type,index,id)`.

**Evidence.** `evidence/openrouter-dialect.md` §5 says `reasoning_details[]` entries are incrementally reassembled by identity but that whole-object semantics need capture; §7.7 says `reasoning_details[].index` streaming reassembly is under-specified; §9.1 and §9.2 list this as open. SPEC §3.2 uses "same segment" without defining a key.

**Fix.** Define a deterministic OpenRouter segment key, e.g. `(id if present else format + index + type group)`, and spell out dedup precedence for displayable vs encrypted entries when ids/indexes differ or are absent.

---

## Attack Surface 8: Migration map (§9)

### COD-AS8-01 · MINOR · §9 item 14

**Failure scenario.** Migration item 14 says finality edge paths are handled by the §3.5 dispatch table, but v0.2 now requires behavior not named in the migration target: Reject must retract/redact already-rendered draft text (COD-AS2-01), and F3 `response.incomplete` must branch by `incomplete_details.reason` (COD-AS2-02). A migration that only implements the current §3.5 table can still leak rejected draft text and can still finalize F3 content-filter partials as truncated answers.

**Evidence.** `evidence/anthropic-messages-sse.md` §6 refusal safety semantics; `evidence/openai-families.md` §B.2/§B.6 `response.incomplete` reason semantics. SPEC §9 item 14 only names the current dispatch table.

**Fix.** Expand item 14 to include channel draft retraction/redaction on Reject and F3 `response.incomplete_details.reason` classification.

---

## Summary table

| ID | Severity | Attack Surface | Short description |
|---|---|---|---|
| COD-AS2-01 | BLOCKER | 2/3/5 | Reject prevents final delivery but can still leak unsafe partial text through live draft |
| COD-AS2-02 | BLOCKER | 2 | F3 `response.incomplete` content-filter cases are misclassified as truncation/final answer |
| COD-AS1-01 | MAJOR | 1 | F3 `content_part.*` marked unsupported even though normal text/refusal/reasoning uses it |
| COD-AS1-02 | MAJOR | 1 | §6 uses wrong OpenRouter summary type string |
| COD-AS1-03 | MAJOR | 1 | F1 `message_start`/`message_stop` have no §6 disposition |
| COD-AS1-04 | MAJOR | 1 | F1 server-tool result blocks have no §6 disposition |
| COD-AS1-05 | MAJOR | 1 | F2 metadata/control fields have no §6 disposition |
| COD-AS2-03 | MAJOR | 2 | F1e has two competing final-answer sources |
| COD-AS2-04 | MAJOR | 2 | F2 legacy `finish_reason:"function_call"` omitted from dispatch table |
| COD-AS3-01 | MAJOR | 3 | Tier A `/verbose off` liveness is defined as an empty/contradictory draft |
| COD-AS4-01 | MAJOR | 4 | F3 `item_id` alone is not a safe segment idempotency key |
| COD-AS5-01 | MAJOR | 5 | OpenRouter `reasoning_details[].signature` can leak to archive/bus |
| COD-AS6-01 | MAJOR | 6 | §3.2 is an unmarked base-contract amendment |
| COD-AS7-01 | MAJOR | 7 | OpenRouter dual-lane "same segment" dedup is mechanically unanswerable |
| COD-AS8-01 | MINOR | 8 | Migration item 14 under-scopes Reject and F3 incomplete fixes |
| COD-AS4-02 | NIT | 4 | §7.3 references nonexistent §5.6 |

**Totals: 2 BLOCKER · 12 MAJOR · 1 MINOR · 1 NIT**
