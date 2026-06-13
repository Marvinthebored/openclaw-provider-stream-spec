# Codex app-server envelope — provider stream catalogue

Status: captured | Date: 2026-06-13 | Agent: Claude (Fable 5)

This is **Peter's main OpenAI transport** in openclaw (ChatGPT OAuth via the codex
harness — `extensions/codex/src/app-server/`). It is an *envelope* family: JSON-RPC
2.0 over stdio wrapping the OpenAI Responses API (F3), with codex's own item model
layered on top. Closest analogue: F1e (claude-cli envelope over F1).

## 1. Sources

- Binary: `codex-cli 0.139.0`, `codex app-server` subcommand (same binary openclaw
  spawns; see `client.ts:179` handshake, `thread-lifecycle.ts:927`
  `experimentalRawEvents: true`).
- Protocol types: `~/openclaw/extensions/codex/src/app-server/protocol.ts` +
  `protocol-generated/json/v2/` (synced from the binary by
  `scripts/sync-codex-app-server-protocol.ts`).
- Captures (in `captures/`, driven by `capture-codex-appserver.mjs` which replays
  openclaw's exact handshake: `initialize` w/ `capabilities.experimentalApi: true` →
  `initialized` → `thread/start` w/ `experimentalRawEvents: true` → `turn/start`):
  - `codex-appserver-reasoning.jsonl` — plain reasoning turn (25 frames)
  - `codex-appserver-tooluse.jsonl` — commentary + commandExecution + final answer
    (~75 frames; 44 agentMessage deltas across BOTH phases)
  - `.sent.jsonl` siblings record the client frames (not part of the golden)
- `codex exec --json` (the non-interactive surface) was also captured
  (`codex-exec-reasoning.jsonl`) — it is a COARSER envelope (item.completed only, no
  deltas, no reasoning item) and is NOT what openclaw consumes. Kept for contrast.
- SCRUB NOTE (pre-publication): goldens contain hostname (`MarvinMBP.local`),
  `installationId`, `planType`, and `/redacted` paths inside developer-instruction
  rawResponseItems. Scrub pass runs LAST per standing rule.

## 2. Frame inventory

All server→client frames are JSON-RPC notifications (no id) except responses to our
requests. `event-projector.ts:238-280` is the authoritative consumer list.

| Frame (method) | Key fields | Semantics | Source |
|---|---|---|---|
| `thread/started` | `thread{id, sessionId, modelProvider, status}` | thread lifecycle open | both captures |
| `turn/started` | `turn{id, threadId}` | turn open | both |
| `item/started` | `item{type, id, ...}` | item open; agentMessage carries `phase` ("commentary"\|"final_answer") and empty `text` | both |
| `item/agentMessage/delta` | `itemId, delta` | assistant text delta, correlate by itemId → phase from item/started | both |
| `item/reasoning/textDelta` | `itemId, delta` | raw reasoning text delta — NOT OBSERVED (raw lane is encrypted under OAuth) | projector:242 |
| `item/reasoning/summaryTextDelta` | `itemId, delta` | reasoning summary delta — NOT OBSERVED in these captures (summary config off; see §9) | projector:241 |
| `item/completed` | full item snapshot | terminal item state; reasoning item: `{content:[], summary:[]}` when nothing exposed | both |
| `item/commandExecution/outputDelta` | `itemId, delta` | streamed tool output | tooluse |
| `rawResponseItem/completed` | `item` = verbatim F3 response item | the underlying Responses-API item: message (incl. `role:"developer"` inputs), `reasoning{encrypted_content, summary}`, `function_call`, `function_call_output`. agentMessage raw items ALSO carry `phase` | both |
| `thread/tokenUsage/updated` | `tokenUsage{total{...reasoningOutputTokens}, last{...}, modelContextWindow}` | usage incl. reasoning-token counts (→ thinking tokens backfill) | both |
| `turn/completed` | `turn{id, status:"completed", error, durationMs}` | turn settle; NO usage here (usage is the tokenUsage frame) | both |
| `account/rateLimits/updated` | `rateLimits{primary/secondary windows, planType}` | operator metadata | both |
| `thread/status/changed`, `mcpServer/startupStatus/updated`, `remoteControl/status/changed` | — | lifecycle noise; not content | both |
| `error` | `error{...}` | turn-level failure (projector:280) | not captured (Dead path) |
| server→client requests | approvals/elicitation (have `id`) | must be answered; read-only+never policy avoids them | protocol.ts |

Item types observed: `userMessage`, `agentMessage`, `reasoning`, `commandExecution`.
Others in projector (`mcpToolCall`, `fileChange`, `webSearch`, `dynamicToolCall`,
`plan`, `contextCompaction`) follow the same started/delta/completed lifecycle.

## 3. Content lanes

- **Final answer**: `agentMessage` items with `phase:"final_answer"` (deltas + snapshot).
- **Commentary/preamble**: `agentMessage` items with `phase:"commentary"` — the
  envelope LABELS the lane explicitly. This is the decisive fact for migration item 4:
  the projector currently routes commentary into the item/preamble lane
  (event-projector.ts:1010-1029); re-routing to `assistant`/`commentary` is mechanical
  because `phase` is right there on item/started AND on the raw item.
- **Thinking**: `reasoning` item exists with deltas defined, but under ChatGPT OAuth
  the raw lane arrives only as `rawResponseItem reasoning.encrypted_content` (opaque
  continuation blob → adapter provider-native transcript ONLY, never bus events).
  Reasoning token count IS available (`tokenUsage.last.reasoningOutputTokens`) →
  normalized `thinking` variant=redacted marker w/ token backfill, per SPEC §3.2.
  Summaries (variant=summary) flow via `summaryTextDelta` when enabled — see §9.
- **Tool calls/results**: typed items (`commandExecution` etc.) with streamed
  `outputDelta`, full snapshot at completed (`aggregatedOutput`, `exitCode`,
  `durationMs`); raw `function_call`/`function_call_output` mirrored on the raw lane.
- **Usage**: `thread/tokenUsage/updated` (NOT on turn/completed).
- **Errors**: `error` notification; `turn.error` field; not yet captured.

## 4. Ordering & interleaving

Observed: userMessage → reasoning → agentMessage(commentary) → commandExecution →
reasoning? → agentMessage(final_answer) → turn/completed. Commentary interleaves
tool items exactly like Harmony commentary channel. `rawResponseItem/completed`
frames interleave 1:1 alongside the projected items they mirror. Correlation is by
`itemId` (+ `threadId`/`turnId` on every frame); no seq numbers — ordering is stream
order (stdio framing, single connection).

## 5. Delta vs snapshot

Delta frames (`*/delta`, `*Delta`) are incremental, keyed by `itemId`; `item/completed`
is a full snapshot (authoritative; agentMessage `text` = concatenated deltas — verified
"391" and tooluse both). `item/started` for agentMessage has `text:""` (lazy).

## 6. Termination & finality

`turn/completed` with `turn.status` = settle. Final answer is distinguished from
interim text by `phase`, NOT by position. Maps to SPEC §3.5: status "completed" →
Finalize; `turn.error` / `error` notification → Dead; interrupt via `turn/interrupt`
request → abort path. Truncation/refusal surfaces TBD (need F3 `incomplete` passthrough
observation — §9).

## 7. Observed dialect deviations

- `codex exec --json` is a different, coarser envelope (no deltas, no reasoning item,
  usage on turn.completed instead of a separate frame). Do not conflate.
- turn/completed lacks usage (unlike exec surface) — usage is a separate notification.
- raw reasoning is encrypted-only under OAuth; `content:[]`/`summary:[]` on the
  projected item even though `reasoningOutputTokens > 0`.

## 8. Proposed normalization (total over §2)

| Envelope frame | Normalized stream |
|---|---|
| `item/agentMessage/delta` + item phase=final_answer | `assistant` phase=final_answer |
| `item/agentMessage/delta` + item phase=commentary | `assistant` phase=commentary **[migration item 4]** |
| `item/reasoning/textDelta` | `thinking` variant=raw |
| `item/reasoning/summaryTextDelta` | `thinking` variant=summary |
| reasoning item w/ encrypted_content only + reasoningOutputTokens>0 | `thinking` variant=redacted (content-free marker, token backfill) |
| `rawResponseItem reasoning.encrypted_content` | adapter provider-native transcript ONLY |
| `item/started`/`completed` (tool types) + `outputDelta` | `tool`/`item` lifecycle |
| `thread/tokenUsage/updated` | usage on lifecycle settle |
| `turn/started`/`turn/completed`/`error` | `lifecycle` (Finalize/Dead per §6) |
| status/rateLimit/mcp noise frames | dropped (operator metadata, not content) |
| `userMessage` items, developer-role raw messages | not channel content (input echo) |

Idempotency: `itemId` is globally unique (`msg_*`, `call_*`); composite not needed.

## 9. Open questions

1. **Summary lane live proof**: openclaw can request reasoning summaries (config
   `model_reasoning_summary`/effort). Re-capture with summaries enabled to golden
   `summaryTextDelta`. (Parallel to the parked OpenAI org-verify item — OAuth may not
   need verification.)
2. **Truncation/refusal**: how does F3 `incomplete`/refusal surface through the
   envelope? Needed for §3.5 Truncate/Reject conformance. Try a tiny max-token config.
3. Approval/elicitation server→client requests during tool turns under openclaw's
   policies — out of content-pipeline scope but the capture script auto-denies.
