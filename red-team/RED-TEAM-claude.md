# Red-team findings: SPEC.md adversarial review

**Reviewer:** Claude (claude-sonnet-4-6), fresh-context adversarial  
**Date:** 2026-06-12  
**Brief:** RED-TEAM-BRIEF.md  
**Spec under review:** SPEC.md v0.1-draft  
**Ground truth:** evidence/*.md, evidence/captures/claude-cli/, reference/agent-event-io-contract-f92c1bf.md  
**Code verified:** ~/openclaw (read-only, ga-build branch)

---

## Attack Surface 1: Mapping totality

### F1-AS1-01 · BLOCKER · §6 table

**Failure scenario.** The F1 frame inventory (evidence/anthropic-messages-sse.md §2) lists a `citations_delta` delta type within `content_block_delta` as documented elsewhere in Anthropic's ecosystem. SPEC §6 F1 column has no row for it — no disposition of "event(s), transcript-only, or documented drop." Conformance test §8.1 requires totality ("every frame type in the family catalogue §2 has exactly one disposition"), so an adapter that encounters a citations delta has no spec-defined behavior and would emit an `unknown_frame` diagnostic rather than the presumably correct treatment. The issue is compounded because the evidence file explicitly flags it as an open question (evidence/anthropic-messages-sse.md §9), yet SPEC §6 does not inherit that caveat or assign even a provisional disposition.

**Evidence.** anthropic-messages-sse.md §2 "(citations deltas)"; §9 "needs a targeted fetch of the citations feature page."

**Fix.** Add a row to §6 F1 column: `content_block_delta (citations_delta)` → disposition: TBD pending citation-feature evidence fetch; provisionally `transcript-only` with `unknown_frame` diagnostic until §7 of the evidence file is filled.

---

### F1-AS1-02 · MAJOR · §6 table

**Failure scenario.** F1 `stop_reason: "pause_turn"` (evidence/anthropic-messages-sse.md §6) is listed in SPEC §3.4 as a normalized stop reason ("paused") and is a real terminal signal, but the §3.5 finality state machine names only `end_turn / finish stop / response.completed / Harmony final` as the triggers for the `Text → Finalize` transition. An adapter receiving `pause_turn` while in the `Text` state does not know from the spec whether to (a) re-tag the in-progress text as `final_answer` and deliver it, (b) leave it as `commentary` awaiting resume, or (c) emit a lifecycle error. The three interpretations produce radically different channel behavior: option (a) delivers a partial response as final; option (b) leaves the draft unsettled; option (c) is incorrect since pause is not an error.

**Evidence.** anthropic-messages-sse.md §6: "pause_turn — a long-running turn was paused; caller resumes by sending the partial response back in a subsequent request." SPEC §3.4 normalizes it as "paused." SPEC §3.5 state machine diagram omits it.

**Fix.** §3.5 must define the `pause_turn` path: `Text → Suspend` (new state, not `Finalize`); "paused" lifecycle event emitted; draft settles to a "paused" visual state; final answer NOT re-tagged until the resumed turn reaches a real end_turn. Add a `Suspend` state to the diagram.

---

### F1-AS1-03 · MAJOR · §6 table

**Failure scenario.** The §6 F1 column `thinking raw` row maps `thinking_delta → variant raw`, but the F1 evidence (anthropic-messages-sse.md §2) defines two distinct delta types within a thinking block: `thinking_delta` (the reasoning text) AND `signature_delta` (the cryptographic signature). The SPEC §3.2 says "Opaque continuation state is NOT bus data" and "signatures → transcript only," which implies `signature_delta` should be transcript-only with no bus event. However, §6 F1 has no dedicated row for `signature_delta`. An implementer reading §6 to construct a total mapping has no explicit cell; they might emit it as a `thinking` event (wrong) or drop it silently (violates the totality requirement). Migration map item 3 mentions "signature_delta not parsed (cli-output.ts)" but this describes the current gap, not the target.

**Evidence.** anthropic-messages-sse.md §2 delta types table, `signature_delta` row. SPEC §3.2: "Anthropic signatures…persisted byte-stable in the session transcript." SPEC §6 F1 column: no `signature_delta` row.

**Fix.** Add to §6 F1 column: `signature_delta` → `(none)` / transcript-only; "consumed by adapter's session transcript, never emitted as a bus event." Same row for F1e (same inner format).

---

### F2/F3-AS1-04 · MAJOR · §6 table

**Failure scenario.** The F2 family evidence (openai-families.md §A.2) identifies `choices[].delta.refusal` as a distinct frame in the Chat Completions SSE — a separate lane from `delta.content`, carrying refusal text. Similarly, F3 (§B.2) has `response.refusal.delta` / `response.refusal.done`. Neither appears in SPEC §6's F2 or F3 columns. An adapter following §6 for total mapping has no disposition for refusal deltas. If treated like ordinary content (appended to the assistant text stream), the refusal is indistinguishable from a normal answer at the semantic layer. If silently dropped, a refusal produces a zero-text turn with only a `lifecycle/end` (confusing UX).

The evidence's own normalization tables (openai-families.md §A.8 and §B.8) do map refusal to `assistant`/`final_answer`, but SPEC §6 — the normative table — omits it entirely.

**Evidence.** openai-families.md §A.2 `choices[].delta.refusal` row; §A.8 `delta.refusal → assistant { delta, phase: "final_answer" }`. openai-families.md §B.2 `response.refusal.delta/.done` row; §B.8 mapping. SPEC §6: no refusal row in F2 or F3 columns.

**Fix.** Add rows to §6 F2 and F3 columns: `delta.refusal` (F2) / `response.refusal.delta/.done` (F3) → `assistant` / `{ delta/text, phase: "final_answer" }`; note that `stop_reason: "refusal"` (F1) takes a different path (see AS2-01 below).

---

### F3-AS1-05 · MAJOR · §6 table

**Failure scenario.** F3 evidence (openai-families.md §B.2) catalogs a large set of frames entirely absent from SPEC §6's F3 column:

- `response.queued` — background/async response queuing  
- `response.content_part.added` / `.done` — content-part lifecycle events  
- `response.audio.delta` / `.done`, `response.audio.transcript.delta` / `.done` — audio output  
- `response.image_generation_call.in_progress` / `.generating` / `.partial_image` / `.completed` — image generation  
- `response.output_text.annotation.added` — citations/annotations  
- `response.custom_tool_call_input.delta` / `.done` — custom tool calls  
- `response.mcp_call_arguments.delta` / `.done`, `response.mcp_list_tools` — MCP tool calls  
- `response.code_interpreter_call.code.delta` / `.done` / `.in_progress` / `.interpreting` / `.completed` — code interpreter lifecycle phases  

SPEC §6 F3 column covers only `function_call` and `built-in *_call.* events` in the tool-calls row, and `response.in_progress` in keepalives. All the above types fall through. With the "unknown frame types: never silently dropped" rule (SPEC §6), an adapter would fire `unknown_frame` diagnostics for every audio, annotation, and image-generation event.

**Evidence.** openai-families.md §B.2 frame inventory, full table.

**Fix.** SPEC §6 must either (a) enumerate dispositions for all B.2 frame types, or (b) add an explicit scoping note: "F3 audio, image-generation, annotations, and MCP frames are out of scope for Phase 1; assigned disposition: `unknown_frame` diagnostic, pending Phase 2." Without this, the totality claim (§8 conformance item 1) is unachievable.

---

### F1e-AS1-06 · MINOR · §6 table

**Failure scenario.** The F1e (claude-cli) column says "inner F1 rule" for most lanes and adds "`result.usage`/`modelUsage` → lifecycle" for usage and "`result.is_error` → lifecycle error" for errors. The actual F1e frame inventory (claude-cli-streamjson.md §2) also includes:

- `system/init` frame — session metadata  
- `system/status(requesting)` — lifecycle ping  
- `rate_limit_event` — subscription rate-limit snapshot  
- `assistant` full-snapshot frames — emitted after each completed block  
- `result` terminal frame — `subtype:"success"`, timing fields, `modelUsage`, `total_cost_usd`

SPEC §6 F1e column has no rows for `system/init`, `system/status`, or `assistant` snapshot frames. SPEC §3.4 mentions `rate_limit_event → lifecycle diagnostic`, but the F1e column only says "inner F1 rule." An adapter writing a total F1e mapping has to infer that `system/init` and `system/status` are dropped or lifecycle-diagnostic, and that `assistant` snapshots are either source-of-truth for tool reconstruction (per cli-streamjson.md §8) or discarded once `stream_event` deltas are in use. The spec says nothing.

**Evidence.** claude-cli-streamjson.md §2 full frame inventory; §3 content lanes; §4 ordering. SPEC §6 F1e column: "inner F1 rule" and usage/error rows only.

**Fix.** Add explicit rows to §6 F1e column: `system/init` → `lifecycle`/start (session metadata); `system/status` → dropped or lifecycle diagnostic; `rate_limit_event` → lifecycle diagnostic (already in §3.4, just missing from table); `assistant` snapshot → transcript-only when `stream_event` deltas are present (consistent with §8 evidence mapping).

---

## Attack Surface 2: Finality algorithm (§3.5)

### AS2-01 · BLOCKER · §3.5

**Failure scenario.** F1 `stop_reason: "refusal"` (evidence/anthropic-messages-sse.md §6: "streaming safety classifiers intervened mid-stream…treat any partial content as non-final/unsafe to surface as a normal answer"). The §3.5 state machine specifies: the Text state transitions to Finalize on "terminal stop signal," and "the last completed text segment [is] re-tagged `final_answer`, delivered on the reliable final-reply path." For a `refusal` stop, the partial text in the in-progress Text segment would be re-tagged `final_answer` and delivered as the user-facing answer. This is incorrect: the evidence explicitly states the partial content is non-final/unsafe. Delivering refusal-truncated text as `final_answer` exposes unsafe or incomplete model output through the reliable delivery path.

The lifecycle stop-reason enumeration in §3.4 does list `refusal` as a normalized value, but §3.5 has no branch for it.

**Evidence.** anthropic-messages-sse.md §6: stop_reason enum, `refusal` entry. SPEC §3.5 state machine.

**Fix.** §3.5 must add a branch: when the terminal signal is `refusal` (F1) or `finish_reason:"content_filter"` (F2), the `Text → Finalize` transition must NOT re-tag the segment as `final_answer`. Instead, emit a `lifecycle`/error event with stop reason `refusal`/`content_filter`, and let the channel's error-rendering path handle it (analogous to an in-stream `error` event).

---

### AS2-02 · MAJOR · §3.5

**Failure scenario.** The §3.5 state machine shows `Text → Finalize` on "terminal stop signal" with the note that the last text segment is "re-tagged `final_answer`, delivered on the reliable final-reply path." For `max_tokens` truncation mid-segment (F1 `stop_reason: "max_tokens"`), the text block is incomplete — the model was generating when the token budget ran out. The spec re-tags this partial text as `final_answer`. This is misleading to users (they receive a truncated answer delivered on the final-reply path with no indication it is truncated) and inconsistent with F1 evidence (anthropic-messages-sse.md §6: "max_tokens — output truncated; any open block may be incomplete").

The `lifecycle` stop-reason list in §3.4 includes `max_tokens`, so the normalized event carries this information. But §3.5 specifies no special handling for it in the finalization step, and the truth table §4.3 has no row for "truncated final answer" rendering.

**Evidence.** anthropic-messages-sse.md §6 `max_tokens` entry. SPEC §3.4, §3.5.

**Fix.** §3.5 must note: when stop reason is `max_tokens`, re-tag the last segment as `final_answer` but flag it as `truncated: true` in the event data; channels must render a truncated indicator (e.g., "[⚠ truncated]") on the durable final message. Add this to §4.3 always-on rows.

---

### AS2-03 · MAJOR · §3.5

**Failure scenario.** A stream that dies without a terminal frame (network error, connection drop, gateway timeout mid-stream). The §3.5 state machine's `Finalize` state is only reached via "terminal stop signal arrives." If the SSE connection closes without `message_stop` (F1), `[DONE]` (F2), or `response.completed`/`response.failed` (F3), the state machine never reaches `Finalize`. The spec gives no exit path for this scenario: the turn is open indefinitely, the draft in the channel is never settled, and the final_answer is never delivered. The base contract (reference/agent-event-io-contract-f92c1bf.md §Lifecycle and terminal events) says "terminal lifecycle must settle `agent.wait` and any channel progress state" but this is a rule about terminal lifecycle events, not about what to do when none arrives.

SPEC §3.4 says "mid-stream provider errors must surface as `phase:'error'`" but this covers in-band error frames, not network-level connection death with no error frame.

**Evidence.** SPEC §3.5 state machine (no exit path for connection-death). SPEC §3.4 error rule. base contract §Lifecycle rules.

**Fix.** §3.5 must add: "If the transport closes abnormally before any terminal stop signal, the adapter must emit a synthetic `lifecycle`/error event with `reason:"stream_closed"` and treat it identically to an in-band `error` event (abort guard active, no final_answer re-tag)." This must also appear in §8 conformance tests.

---

### AS2-04 · MAJOR · §3.5

**Failure scenario.** F2 `finish_reason: "tool_calls"` with a zero-text turn (no `delta.content` at all — the model went straight to tool calls). The §3.5 state machine has `Open → Finalize` on "terminal stop with no open text." The spec says: "last completed text segment re-tagged `final_answer`, delivered on the reliable final-reply path." But there is no text segment. The channel is told to deliver a `final_answer` with no content — which could manifest as an empty message sent to the user, or as a crash if the final-reply path requires non-empty content. The truth table §4.3 "always-on rows" does not address zero-text final_answer delivery.

**Evidence.** openai-families.md §A.6 `finish_reason: "tool_calls"` — "model finished emitting tool calls and is yielding control back; no separate final text is part of this CC stream." SPEC §3.5.

**Fix.** §3.5 must clarify: "If `Open → Finalize` with no completed text segment, no `final_answer` event is emitted for this turn. The turn ends with `lifecycle`/end. The final answer arrives in a subsequent turn once tool results are processed."

---

### AS2-05 · MAJOR · §3.5

**Failure scenario.** The §3.5 double-posting prevention claim ("same guard as the base contract's mirror exclusion, applied at the channel") depends on idempotency key `runId + segment id`. The spec notes F2 uses a "synthesized counter" for segment id (§3.1). But F2 (Chat Completions SSE, openai-families.md §A) has no sequence number and no segment id — the adapter synthesizes a counter. If there are parallel tool calls (`delta.tool_calls[]` with multiple indices) interspersed with content deltas, the counter assignment depends on the order events are processed. If two channels reconnect at different times and see events in different interleaving orders (possible with `dropIfSlow:true` causing gaps), the synthesized counter values can diverge across sessions, making the idempotency key unreliable.

**Evidence.** openai-families.md §A.4: "chunks for different choices can interleave." SPEC §3.1: "synthesized counter for F2." SPEC §7.3 idempotency key.

**Fix.** Specify the exact synthesis rule for F2 segment IDs (e.g., monotonic integer per text-content run within a turn, reset on each new SSE connection with the `runId` as the true stable identifier). Alternatively, acknowledge that F2 idempotency is weaker and require channels to use `runId + seq` (not `runId + id`) for F2 commentary segments.

---

## Attack Surface 3: Truth table (§4.3)

### AS3-01 · BLOCKER · §4.3

**Failure scenario.** The §4.3 truth table is described as "path-independent (primary == queued)" but the internals audit (evidence/openclaw-internals.md §1) shows that the `onReasoningStream` → `draftPreview.pushReasoningProgress` path silently no-ops when `params.mode !== "progress"` (`progress-draft-compositor.ts:215-221`). Followup/queued turns may run with no live draft in progress-mode. This means `/reasoning stream` produces no rendered thinking on the queued path — the truth table's `/reasoning stream` cell ("rendered live in draft, settles at segment end") is FALSE for the queued path. The table's claim of path-independence is contradicted by real code behavior, and SPEC §7.2 Discord section does not fix this (it says the hard drops at 602/645 are "deleted," but does not address the draft-availability divergence for queued turns).

**Evidence.** evidence/openclaw-internals.md §1, Primary vs followup section: "divergence is in whether `draftPreview`/`draftStream` is an active, in-progress-mode draft for a followup turn — followup turns may run with `draftPreview.isProgressMode` false/absent." SPEC §4.3.

**Fix.** Either (a) require the queued path to always create an active draft before streaming thinking events (so the table holds), or (b) amend the table with a footnote: "`/reasoning stream` degrades to `on` behavior on the queued path when no in-progress draft is active; channel must not claim stream-live rendering in this case."

---

### AS3-02 · MAJOR · §4.3

**Failure scenario.** The truth table `/reasoning on` cell for `thinking raw/summary deltas`: "rendered at segment end (collapsed/quoted block)." For Tier A (Discord), the spec (§7.2) says "🧠-prefixed blockquote segments." Discord has a 2000-character hard limit per message. A long reasoning segment (common with `thinkingLevel: "max"` — several thousand tokens) would exceed this limit when rendered as a blockquote in the single in-place-edited draft message. The spec provides no instruction for what happens: split across multiple messages? Truncate? The SPEC claims the draft is "one in-place-edited activity draft per turn" — splitting it breaks that model.

**Evidence.** SPEC §7.2: "One in-place-edited activity draft per turn"; "🧠-prefixed blockquote segments." Discord 2000-char limit per message (channel platform constraint). No character-overflow handling in §7.2 or §4.3.

**Fix.** §7.2 must specify the overflow strategy for Tier A: "if thinking text exceeds the remaining draft capacity, truncate with '…[N chars omitted]' or route to a thread/spoiler variant." This is a missing implementation contract, not a visual design preference.

---

### AS3-03 · MAJOR · §4.3

**Failure scenario.** The truth table has two independent tables (one for `/reasoning`, one for `/verbose`) with no combined-setting rows. Consider `/reasoning off` + `/verbose off`: the always-on rows specify `assistant commentary/deltas` are "streamed into the transient draft." But the draft itself exists to display activity. With both settings off and no tool rows and no thinking rows, only commentary text goes in the draft. Is the draft still created? Does it still settle at turn end? The spec does not define the degenerate case. If commentary text is also empty (zero-text tool-only turn), what does the draft contain? Nothing, yet the spec says the draft "settles (collapses to a one-line summary: '🧠 n segments · m tools · k s')" — but with n=0 and m=0, this summary string is meaningless.

**Evidence.** SPEC §4.3 always-on rows; §7.2 Discord draft settle format.

**Fix.** §7.2 or §4.3 must define: "if the settled summary would contain all-zero counts (no thinking, no tools, no commentary), the draft is silently dismissed rather than shown." Alternatively, require at minimum "k s" (elapsed time) to always be shown.

---

### AS3-04 · MINOR · §4.3

**Failure scenario.** The `liveness indicator` referenced in the truth table (`/verbose off` cell: "liveness indicator only") is never defined. The glossary (§11) defines segment, turn, draft, settle, marker, and archive tap — but not liveness indicator. It's unclear whether this is: a spinner emoji, a "bot is thinking…" status message, a Discord typing indicator (bot setTyping), a no-op (nothing shown), or the existing activity draft with no content. Different implementers will make different choices, producing inconsistent UX across Tier A channels.

**Evidence.** SPEC §4.3 table `/verbose off` column; §11 glossary (liveness indicator absent).

**Fix.** Add to §11 Glossary: "**liveness indicator** — the minimum honest signal that work is in progress, backed by real events (per base contract §User promise). For Tier A: the draft message is created and edited in place but shows no tool rows; for Tier C/D: a spinner or static 'working…' line. Must not be absent when work is ongoing."

---

## Attack Surface 4: Idempotency/ordering (§7.3)

### AS4-01 · MAJOR · §7.3

**Failure scenario.** §7.3 states "reconnect must not replay rendered rows" but specifies no mechanism. The archive tap (§5.4) stores all events. On reconnect, a channel theoretically could use the archive to replay missed events. The spec does not define: (a) what "rendered" means (persisted in the channel's own storage? delivered to the channel's rendering layer?); (b) how the channel knows which seq it last processed; (c) whether the archive is queryable by seq range. Without this protocol, every reconnect implementation is ad hoc. Two channel implementations that both claim to be §7.3-conformant could handle reconnects differently — one re-renders everything (duplicates), another re-renders nothing (silently drops).

**Evidence.** SPEC §7.3. §8 conformance item 3: "reconnect produces no duplicates." No checkpoint protocol defined anywhere in the spec.

**Fix.** §7.3 must specify a minimum reconnect protocol: "The channel persists `lastRenderedSeq` per `runId` in its own stable storage. On reconnect, it requests the gateway to replay events from `lastRenderedSeq + 1` (or from the archive tap). Events with seq <= lastRenderedSeq are discarded; events with seq > lastRenderedSeq are applied. The gateway must not replay `final_answer` events via the progress path (idempotency of final delivery is separate)."

---

### AS4-02 · MAJOR · §7.3

**Failure scenario.** `dropIfSlow:true` applies to thinking events via §5.1 ("same `dropIfSlow:true`"). If thinking events are dropped for a slow channel, they are never rendered by that channel — but they ARE archived (§5.4). The idempotency key for a thinking segment is `runId + id`. On reconnect, the channel has no rendered state for these events (they were dropped), so the "reconnect must not replay rendered rows" rule does not apply. Should the channel then render the previously-dropped thinking events on reconnect (catch-up from archive), or should it treat them as permanently dropped? If it renders them post-turn, they appear out of order relative to the already-rendered final answer — confusing for the user. The spec has no rule for this.

**Evidence.** SPEC §5.1 `dropIfSlow` applied to thinking. §5.4 archive independent of dropIfSlow. §7.3 idempotency.

**Fix.** §7.3 must add: "Events dropped by `dropIfSlow` for a channel during a turn are NOT replayed to that channel from the archive after the turn completes. The archive serves operators/audit, not live channel catch-up. Channels may only catch up missed events from within the current active turn (before `lifecycle`/end)."

---

### AS4-03 · MINOR · §7.3

**Failure scenario.** Crash-mid-draft: OpenClaw crashes after emitting commentary events (which the channel has rendered into its draft) but before the `final_answer` is delivered. The channel's draft message exists in Discord (or another Tier A channel) in an unsettled state. On restart, the channel has no indication whether the turn completed. The spec says "final answer exactly once" (§8 conformance) but does not specify the crash-recovery protocol. Should the restarted channel: (a) query the archive for whether a `lifecycle`/end event was emitted; (b) delete the orphaned draft; (c) update it to an error state? The base contract says "terminal lifecycle must settle agent.wait" but that assumes the agent is still running.

**Evidence.** SPEC §7.3, §8 conformance item 3.

**Fix.** Add to §7.3: "On process restart, channels must check the archive for any in-progress run whose `lifecycle`/end was not yet delivered (i.e., archive has `lifecycle`/start but no `lifecycle`/end). Such runs are settled in error state: the orphaned draft is updated to 'agent interrupted' and dismissed. Final answer is not redelivered without explicit user re-trigger."

---

## Attack Surface 5: Privacy/security

### AS5-01 · MAJOR · §3.2 + §5

**Failure scenario.** SPEC §3.2 says "Emission is unconditional whenever the wire carries reasoning content." SPEC §5.4 says the archive tap stores all normalized events settings-independently. This means: if a model generates raw thinking content (e.g., F1 extended thinking with `display:"summarized"`), the `thinking`/variant:raw events go to the archive regardless of `reasoningLevel` setting. The session archive, by design, holds raw thinking content for every user turn that produced thinking. If the archive implementation (which is not yet built — migration map item 7) stores this in a queryable form (e.g., a database, log file, or session replay endpoint), it becomes a persistent raw-reasoning exfiltration vector: any operator or compromised component with archive read access can retrieve raw thinking content from users who never opted into `/reasoning on`.

The spec explicitly calls this out as a goal ("archived in the session record regardless of display settings") but does NOT define access controls, encryption requirements, or retention limits for raw thinking in the archive. §10 Assumptions/Open Risks does not list this.

**Evidence.** SPEC §0 Goal (b): "archived in the session record regardless of display settings." §3.2 "Emission is unconditional." §5.4 "independent of every flag." §10 does not list this as a risk.

**Fix.** §10 must add an explicit risk: "Archive tap stores raw thinking content from all turns. The archive MUST NOT be readable by channel-facing components without the same `/reasoning`-level authorization as the channel's display. Access to the archive tap requires operator-level trust; user-level channel sessions must not be able to query it. This is a privacy surface requiring a separate access-control spec before Phase 1 ships." Until then, §5.4 should note: "The archive tap is operator/audit access only; no channel projection path reads it."

---

### AS5-02 · MINOR · §3.2

**Failure scenario.** SPEC §3.2 says "Opaque continuation state is NOT bus data": "Anthropic signatures, F3 `encrypted_content`, OpenRouter `reasoning_details[].data` are persisted byte-stable in the session transcript by the adapter." However, the spec doesn't distinguish between: (a) the normalized-event archive (§5.4), and (b) the provider-native session transcript (e.g., F1 `session-transcript-repair.ts`). The Anthropic signature bytes are cryptographic material required for multi-turn replay — if they end up in the general-purpose session archive (not just the provider-native transcript), then any archive reader gains access to the signature bytes. The F1 evidence (anthropic-messages-sse.md §3) states these "must be preserved byte-for-byte and replayed unmodified" — leaking them outside the adapter's internal transcript is a security concern.

**Evidence.** SPEC §3.2: "persisted byte-stable in the session transcript by the adapter." §5.4: archive tap captures normalized events. anthropic-messages-sse.md §3: signature bytes must be byte-stable and provider-only.

**Fix.** §3.2 must explicitly state: "The adapter-internal session transcript (for provider round-trip) is NOT the gateway archive tap. Signatures and encrypted content land only in the adapter's provider-native transcript; they are never emitted as normalized events and therefore never reach the gateway archive."

---

## Attack Surface 6: Coherence with the base contract

### AS6-01 · BLOCKER · §5 vs base contract §Gateway session mirror

**Failure scenario.** SPEC §5.1 states: "Hidden session-subscriber mirror extends to `stream:'thinking'` (all variants)." The base contract (reference/agent-event-io-contract-f92c1bf.md, §Gateway session mirror contract, "Must not mirror as hidden commentary") explicitly lists: "Private reasoning or analysis events" as something that MUST NOT be mirrored to hidden channel-session subscribers.

SPEC §4 header says "Where this spec and that contract conflict, this spec proposes the amendment; it does not silently override." However, §5 never explicitly calls out this as an amendment to the "Must not mirror" list. A reader implementing the base contract and then applying SPEC as an overlay would see a contradiction: the base contract says don't mirror thinking; the SPEC says do mirror thinking. Without an explicit "this amends base contract §Gateway §Must not mirror" statement in §5, the conflict is silent and ambiguous about which wins.

This matters practically: if the SPEC's intent (mirror thinking) is correct, then all existing implementations following the base contract's "don't mirror thinking" rule are non-conformant post-SPEC. If someone reads only the base contract (e.g., for ClickClack integration), they will build a gateway that drops thinking, contradicting the SPEC.

**Evidence.** base contract §Gateway session mirror contract §"Must not mirror as hidden commentary" bullet 3: "Private reasoning or analysis events." SPEC §5.1. SPEC header: "Where this spec and that contract conflict, this spec proposes the amendment."

**Fix.** §5 must explicitly state: "NOTE: This amends base contract §Gateway §'Must not mirror as hidden commentary' — item 'Private reasoning or analysis events' is superseded. `stream:'thinking'` events (all variants) ARE mirrored to hidden channel-session subscribers. Channels gate display via `reasoningLevel`; suppression happens at the channel layer, not the gateway mirror layer."

---

### AS6-02 · MAJOR · §3 vs base contract §Idempotency

**Failure scenario.** The base contract §Channel output contract §Idempotency says: "Assistant commentary segment: `runId + seq`, or a provider item id when one exists." SPEC §7.3 says: "commentary segment: `runId + id` (or `runId + seq` when no segment id)." These are in opposite priority order. The base contract prefers `seq` (falling back to item id), while SPEC prefers `id` (falling back to seq). The difference matters: `seq` is the universal ordering key assigned by the event bus (stable), while `id` is the provider-assigned segment id (stable only within that provider's block-id space). For F2, `id` is synthesized by the adapter (not stable across reconnects), while `seq` is assigned by the bus (stable within a run). Using `id` as primary for F2 is therefore weaker than the base contract's `seq`-first preference.

**Evidence.** base contract §Idempotency: "`runId + seq`, or a provider item id when one exists." SPEC §7.3: "`runId + id` (or `runId + seq` when no segment id)."

**Fix.** SPEC §7.3 must either (a) align with the base contract's `seq`-primary order and add a note explaining why `id` is preferred for F1/F3 (where ids are provider-stable), or (b) call out explicitly that this amends the base contract's idempotency order for adapters that provide stable `id`s.

---

### AS6-03 · MINOR · §3.3 vs base contract §Tool/item

**Failure scenario.** SPEC §3.3 adds a rule: "adapters must emit `phase:'start'` as soon as the call id+name are known (first F2 tool_call delta, F1 `content_block_start`, F3 `output_item.added`)." The base contract §Tool and item events says: "Emit `phase:'start'` before the tool or command begins whenever the provider/runtime knows the call in advance." The base contract phrase "whenever the provider/runtime knows the call in advance" permits NOT emitting `phase:'start'` for providers that don't expose call name until argument completion. SPEC §3.3's "as soon as id+name are known" is stricter (must emit immediately), but the SPEC does not call this out as an amendment to the base contract's `whenever…in advance` wording. An implementer reading both docs may see these as compatible, missing that the SPEC's rule is stricter.

**Evidence.** SPEC §3.3. base contract §Tool and item events §Rules.

**Fix.** §3.3 should note: "This tightens the base contract's 'whenever known in advance' rule to: emit `phase:'start'` at the earliest moment id and name are available, even before arguments complete. Never delay until argument assembly is done."

---

## Attack Surface 7: Mechanical answerability

For each query, I attempt to answer purely from SPEC.md text and document exactly where the spec fails to determine the answer.

---

### Q1: provider=pioneer/F2, transport=HTTP SSE, /reasoning=on, /verbose=off, channel=Tier A (Discord). Prompt produces commentary text, then a tool call, then a final answer, with a reasoning field in delta. What exactly renders in the draft and what is the durable final message?

**Attempt.**

1. Commentary text (`delta.content` while tool call pending) → §6 F2 column "commentary → `delta.content` while turn open" → `assistant`/commentary → §4.3 always-on: "streamed into the transient draft." ✓
2. Tool call (`delta.tool_calls[]`) → §6 F2: "item start/update/end" → §4.3 `/verbose off`: "liveness indicator only." **FAIL: liveness indicator is undefined.** (See AS3-04)
3. Reasoning field (`delta.reasoning` or sibling field) → SPEC §1 says pioneer uses "4+ sibling field names (`reasoning_content`/`reasoning`/`reasoning_text`/`reasoning_details[]`) inconsistently; F2 dialects" and §3.2 says "emit as `thinking`/raw." With `/reasoning on`, §4.3: "rendered at segment end (collapsed/quoted block)." **PARTIAL: what format? blockquote? 🧠 prefix?** §7.2 says "🧠-prefixed blockquote segments" for Tier A, but only for Discord-specific section. ✓ (barely)
4. Final answer → §3.5 finalize → `final_answer` → §4.3 always-on: "durable message on reliable path; replaces draft rendering of that segment." ✓
5. Draft settle → §7.2: "collapses to one-line summary '🧠 n segments · m tools · k s'." ✓

**SPEC fails to answer**: (a) What exactly is the "liveness indicator" for `/verbose off`? (b) If pioneer's reasoning field name is unknown (§10 Assumption 2: "Reasoning field name unknown (4 candidates)"), how does the F2 adapter handle it? SPEC §3.2 lists all 4 names but §6 F2 says "sibling reasoning fields → variant raw" without specifying field-name priority. The evidence (openai-families.md §A.2 / pioneer-dialect.md §2) documents the probe order, but SPEC §6 doesn't. Partially answerable: 3/5 elements mechanically determinable from SPEC, 2 require the implementer to read the evidence files (not the spec).

---

### Q2: provider=F1 Anthropic SSE, transport=HTTP SSE, /reasoning=stream, /verbose=full, channel=Tier A (Discord). Model produces an extended thinking block with `display:"omitted"` (signature-only, no `thinking_delta`). What renders?

**Attempt.**

1. Thinking block opens: `content_block_start` type `thinking` → §6 F1: "thinking raw → `thinking_delta` → variant raw." But evidence says `display:"omitted"` produces ONLY a `signature_delta` — no `thinking_delta` at all. The F1 column says "signature-only → marker" in the `thinking redacted` row. **AMBIGUOUS.** Is a signature-only block in streaming context the same as `redacted_thinking`? The evidence (anthropic-messages-sse.md §3) says "a `thinking` block whose `display:'omitted'` produces only a `signature_delta` (no `thinking_delta`)." SPEC §3.2 says `redacted` variant applies to "signature-only blocks" but places this under "F1 `redacted_thinking`/signature-only → marker" in the redacted row. The word "signature-only" in §6 F1 is the signal, but it's buried in the redacted row, not the raw row.
2. With `/reasoning stream`, §4.3: redacted marker → "same as `on`" → "thought privately (N tok)" row. ✓ (if the ambiguity above is resolved correctly)
3. The "N tok" value: `thinking_tokens` from `message_delta.usage.output_tokens_details.thinking_tokens`. Does the spec say where the `tokens` field on the `thinking` marker comes from? §3.2 says `tokens?: number // thinking-token count when the provider reports it`. For the signature-only case, `thinking_tokens` is 19 in the live capture (claude-cli-streamjson.md §3) — the count IS available in `message_delta.usage`, not in the thinking block itself. **FAIL: spec doesn't say when to populate `tokens`, only that it's "when the provider reports it"** — doesn't specify which frame provides it for F1 specifically.

**SPEC partially answerable but fails on**: (a) whether signature-only `thinking` block maps to `redacted` variant (requires inferring from §6 F1 redacted row wording "signature-only"); (b) how/when to populate `tokens` on the redacted marker for F1 (no frame-level citation).

---

### Q3: provider=F3 Responses API, transport=HTTP SSE, /reasoning=off, /verbose=on, channel=Tier B (Control UI). Model returns `response.incomplete` (hit max_output_tokens). What exactly renders?

**Attempt.**

1. `response.incomplete` → §6 F3 errors row: "`error`/`response.failed`/`incomplete`" → "lifecycle error." **AMBIGUOUS.** `response.incomplete` is NOT an error — evidence (openai-families.md §B.6): "Early/truncated termination (hit token limit, content filter)...ends with `response.incomplete`. Not an error per se." SPEC §6 lumps `incomplete` with `error` and `response.failed` into "lifecycle error." But §3.4 stop-reason list has `max_tokens` as a distinct normalized value (not `error`). So the normalization is ambiguous: does `response.incomplete` produce `lifecycle`/`phase:"error"` or `lifecycle`/`phase:"end"` with `status:"incomplete"`?
2. §4.3 truth table: "lifecycle error → error notice; closes/marks the draft." But for Tier B (Control UI), §7.2 just says "Gains: redacted markers, thinking variants labeled, item rows from the unified grammar." No specific guidance on `response.incomplete` rendering.
3. `/reasoning off` → §4.3: thinking not rendered. `/verbose on` → tool name + status rows. ✓ for those.

**SPEC fails to answer**: Is `response.incomplete` mapped to `lifecycle`/error or `lifecycle`/end-with-truncated? The §6 table grouping is wrong (see AS2-02). The rendering depends on which phase is emitted, which is undefined.

---

### Q4: provider=F1e claude-cli, transport=subscription (no API key), /reasoning=on, /verbose=on, channel=Tier A (Discord). A `rate_limit_event` arrives at frame 3. What does the user see?

**Attempt.**

1. `rate_limit_event` → §3.4 says "claude-cli `rate_limit_event` → `update` diagnostic" → `lifecycle`/update. ✓
2. §4.3 truth table: no row for `lifecycle`/update. The always-on rows cover `lifecycle`/error and `lifecycle`/end but NOT `lifecycle`/update. **FAIL: spec never says what a `lifecycle`/update event renders (or doesn't render) in a channel.**
3. §7.1 Tier A minimum: "required for every tier: final answer delivered exactly once; errors surfaced; 'agent is working' backed by real events." A `rate_limit_event` diagnostic is not an error. Should it be shown? The spec doesn't say.

**SPEC fails to answer**: What does a channel do with `lifecycle`/update diagnostic events? The truth table has no row for them. A Tier A channel implementer has no spec-defined rendering obligation.

---

### Q5: provider=OpenRouter (F2 dialect), /reasoning=on, /verbose=off, channel=Tier A (Discord). Model returns BOTH `delta.reasoning` (flat string) AND `delta.reasoning_details[]` with `reasoning.text` and `reasoning.encrypted` entries simultaneously. What does the bus receive and what renders?

**Attempt.**

1. §6 F2 column: "sibling reasoning fields → variant raw" for `thinking raw`. For `thinking redacted`: "`reasoning_details[type=encrypted]` → marker." For `thinking summary`: "`reasoning_details[type=summary]`."
2. The evidence (openrouter-dialect.md §7.1) explicitly warns: "Two parallel, possibly-inconsistent reasoning lanes. `reasoning` (flat string) and `reasoning_details[]` (structured) can both be populated." **FAIL: SPEC §6 does not specify what the adapter does when BOTH are present.** Does it prefer `reasoning_details` and ignore `reasoning`? Does it emit two separate thinking events (one from each lane)? If two events are emitted, does the channel show the same reasoning content twice?
3. With `reasoning.text` AND `reasoning.encrypted` in the same `reasoning_details[]`: spec says emit `thinking`/raw for `reasoning.text` and `thinking`/redacted marker for `reasoning.encrypted`. Both are emitted. With `/reasoning on`, §4.3: raw → "rendered at segment end"; redacted → "'thought privately (N tok)' row." The user would see BOTH the full reasoning text AND "thought privately" — showing both is confusing and likely incorrect (the encrypted block is the same reasoning, round-tripped, not additional thinking).

**SPEC fails to answer**: (a) When both `reasoning` and `reasoning_details` are present, which wins? (b) When `reasoning_details` contains both `reasoning.text` and `reasoning.encrypted` for the same reasoning segment, should both be emitted (double-showing the same reasoning) or deduped?

---

## Attack Surface 8: Migration map (§9)

### AS8-01 · MAJOR · §9 item 1

**Claim.** "embedded: commentary phase fully dropped (`handlers.messages.ts:678`)."

**Verification.** `~/openclaw/src/agents/embedded-agent-subscribe.handlers.messages.ts` line 678: confirmed `if (deliveryPhase === "commentary") { return; }`. The claim is correct. However, the description "fully dropped" understates what the evidence shows (evidence/openclaw-internals.md §2 adapter table): commentary is dropped from BOTH the agent-event bus AND the reply payload. The spec target "emit `assistant`/commentary" must cover both the bus event AND the route to reply payloads — but §9 item 1 only mentions adapter layer. No gateway or channel migration step addresses what channels do with commentary events after they start arriving. The migration is under-scoped relative to the description in §4.2 "AFTER" diagram which requires channel rendering changes for commentary.

**Evidence.** evidence/openclaw-internals.md §2 Embedded adapter table, Commentary/narration row: "NONE — short-circuits before any emission." SPEC §4.2 "AFTER" diagram.

**Fix.** §9 item 1 should note: "commentary suppression exists at TWO sites: (a) the bus-event emission short-circuit at handlers.messages.ts:678 and (b) the `shouldSuppressAssistantVisibleOutput` check (handlers.messages.ts:45-47). Both must be removed; removing only one leaves commentary in an inconsistent state."

---

### AS8-02 · MAJOR · §9 item 3

**Claim.** "claude-cli: `thinking_delta`/`signature_delta` not parsed (`cli-output.ts`)."

**Verification.** `~/openclaw/src/agents/cli-output.ts` (854 lines): `grep -n "thinking_delta\|signature_delta"` returns ZERO results. The only delta type parsed is `text_delta` (cli-output.ts:409: `if (delta.type !== "text_delta" ...)`). The migration claim is accurate.

**HOWEVER**, the migration item omits the second gap: `cli-output.ts` also does not extract thinking from the `assistant` full-snapshot frames (which contain `message.content[].type === "thinking"` blocks). The evidence (claude-cli-streamjson.md §8) notes: "Since OpenClaw's streaming parser does not extract `thinking_delta`/`signature_delta`, is there a separate non-streaming path (e.g. final `assistant` snapshot's `content[].type === 'thinking'`) that surfaces thinking text?" The answer, from code inspection, is no — `cli-output.ts` filters content to text blocks only. Migration item 3 must address both the delta path AND the snapshot path.

**Evidence.** cli-output.ts: no `thinking_delta` or `signature_delta` parsing. claude-cli-streamjson.md §9 open question 2.

**Fix.** §9 item 3 should read: "claude-cli: `thinking_delta`/`signature_delta` not parsed, AND `assistant` snapshot frames' `thinking` content blocks not extracted (`cli-output.ts`). Fix: extract thinking from both the streaming `thinking_delta` delta events AND the completed `assistant.message.content` thinking blocks (for `--include-partial-messages` mode)."

---

### AS8-03 · MINOR · §9 item 4

**Claim.** "codex: Harmony commentary as `item`/preamble (`event-projector.ts:1010`)."

**Verification.** `~/openclaw/extensions/codex/src/app-server/event-projector.ts` line 1010: `private emitCommentaryProgress(params: { itemId: string; text: string }): void {` — confirmed, this is the method that emits `stream:"item"` with `kind:"preamble"`. The line number is accurate.

**Under-specification issue.** The spec target is "re-route to `assistant`/commentary." But the migration involves more than changing the stream name — `emitCommentaryProgress` currently deduplicates based on `lastCommentaryProgressTextByItem` (event-projector.ts ~1014), which prevents emitting the same commentary text twice. If this is removed (to emit raw `assistant`/commentary events), the dedup logic must also be updated or moved to the bus/channel layer. The migration item doesn't mention this.

**Evidence.** event-projector.ts:1010-1030 (read above).

**Fix.** §9 item 4 should note: "event-projector.ts also has commentary deduplication logic at the emit site. This logic must be migrated to the channel layer (consistent with the 'gate only at presentation' principle) rather than removed, to prevent duplicate commentary rows on channels that track by text content."

---

### AS8-04 · MINOR · §9 item 5

**Claim.** "ACP: thinking off-bus (`translator.ts:1116`)."

**Verification.** `~/openclaw/src/acp/translator.ts` line 1116: `sessionUpdate: "agent_thought_chunk",` — confirmed, this emits thinking as a native ACP `agent_thought_chunk` session update, NOT as a normalized `stream:"thinking"` agent event. The line number is accurate.

**Under-scoping issue.** The spec target is "dual-emit: native ACP + `thinking` event." However, the evidence (evidence/openclaw-internals.md §2 ACP table) notes: "For non-ACP channel subscribers (e.g. a Discord session bound to an ACP-backed agent), thinking content is **not mirrored**." Adding dual-emit to `translator.ts:1116` is only part of the fix — the ACP architecture may have multiple thinking-emission sites (the evidence notes `translator.replay.ts:14,57` and `event-mapper.ts`). The migration item cites only `:1116`.

**Evidence.** evidence/openclaw-internals.md §2 ACP table. translator.ts:1116, translator.replay.ts (unchecked in this pass).

**Fix.** §9 item 5 should expand: "ACP thinking off-bus at ALL sites: `translator.ts:1116`, `translator.replay.ts:14,57`, and any `event-mapper.ts` paths. All must dual-emit."

---

### AS8-05 · NIT · §9 item 2 vs evidence

**Claim.** "embedded: `thinking` emission gated by `streamReasoning` (`embedded-agent-subscribe.ts:1162`)."

**Verification.** Line 1162: `stream: "thinking",` is inside the `emitReasoningStream` function, gated at line 1143: `if (!state.streamReasoning || !params.onReasoningStream) { return; }`. The claim is accurate in substance. However, the gate at line 1143 is TWO conditions (`streamReasoning` AND `onReasoningStream`), not just `streamReasoning`. The migration spec says the gate "move[s] from suppressing emission to annotating display defaults." But after the migration, if `onReasoningStream` is no longer a gating condition (because emission is unconditional), that second condition must also be removed. The migration item says nothing about `onReasoningStream` callback wiring.

**Evidence.** embedded-agent-subscribe.ts:1143.

**Fix.** §9 item 2 note: "Remove BOTH conditions at line 1143 (`streamReasoning` gate AND `onReasoningStream` gate). After migration, `thinking` events are emitted unconditionally via `emitAgentEvent`; the `onReasoningStream` callback becomes a channel-layer hook for live rendering only, not an emission gate."

---

## Summary table

| ID | Severity | Attack Surface | Short description |
|---|---|---|---|
| F1-AS1-01 | BLOCKER | 1 | F1 citations_delta has no disposition in §6 |
| AS2-01 | BLOCKER | 2 | Finality re-tags refusal partial text as final_answer (unsafe) |
| AS3-01 | BLOCKER | 3 | Truth table claims path-independence; code proves it false for /reasoning stream on queued path |
| AS6-01 | BLOCKER | 6 | §5 mirrors thinking to hidden subscribers; base contract says don't; no explicit amendment |
| F1-AS1-02 | MAJOR | 1 | pause_turn not in §3.5 finality state machine |
| F1-AS1-03 | MAJOR | 1 | signature_delta has no row in §6 F1 column |
| F2/F3-AS1-04 | MAJOR | 1 | F2/F3 refusal fields missing from §6 table |
| F3-AS1-05 | MAJOR | 1 | F3 audio/image/MCP/annotation frames entirely absent from §6 |
| F1e-AS1-06 | MINOR | 1 | F1e system/init, system/status, assistant snapshot frames absent from §6 |
| AS2-02 | MAJOR | 2 | max_tokens re-tags truncated text as final_answer with no truncated marker |
| AS2-03 | MAJOR | 2 | Stream-death without terminal frame: no exit path in §3.5 state machine |
| AS2-04 | MAJOR | 2 | Zero-text tool-only turn: Open→Finalize produces empty final_answer event |
| AS2-05 | MAJOR | 2 | F2 synthesized counter IDs are reconnect-unstable; breaks idempotency guarantee |
| AS3-02 | MAJOR | 3 | Discord 2000-char limit on /reasoning on rendered blockquote: no overflow strategy |
| AS3-03 | MAJOR | 3 | Combined settings (both off, zero-count summary): degenerate draft behavior undefined |
| AS3-04 | MINOR | 3 | "liveness indicator" undefined in spec and glossary |
| AS4-01 | MAJOR | 4 | Reconnect protocol undefined; "must not replay rendered rows" has no mechanism |
| AS4-02 | MAJOR | 4 | dropIfSlow-dropped thinking events: no rule on post-turn archive catch-up |
| AS4-03 | MINOR | 4 | Crash-mid-draft recovery protocol undefined |
| AS5-01 | MAJOR | 5 | Archive stores raw thinking always; no access controls defined |
| AS5-02 | MINOR | 5 | Signature bytes could leak into gateway archive if "session transcript" is ambiguous |
| AS6-01 | BLOCKER | 6 | (see above) |
| AS6-02 | MAJOR | 6 | §7.3 idempotency key priority reverses base contract's order silently |
| AS6-03 | MINOR | 6 | §3.3 tool start-timing rule is stricter than base contract but not called out as amendment |
| AS8-01 | MAJOR | 8 | §9 item 1 under-scopes commentary migration (two suppression sites, not one) |
| AS8-02 | MAJOR | 8 | §9 item 3 misses thinking extraction from assistant snapshot frames |
| AS8-03 | MINOR | 8 | §9 item 4 omits commentary deduplication migration |
| AS8-04 | MINOR | 8 | §9 item 5 under-scopes ACP dual-emit to only one call site |
| AS8-05 | NIT | 8 | §9 item 2 omits onReasoningStream condition alongside streamReasoning gate |

**Totals: 4 BLOCKER · 15 MAJOR · 7 MINOR · 1 NIT**
