# OpenClaw internals audit: streaming/reasoning/verbosity gates, adapter emit/drop, channel capability

Repo: /redacted/openclaw (branch ga-build), read-only audit. All paths repo-relative unless noted.

## 1. SETTINGS GATE MAP

### `/reasoning` -> `reasoningLevel` (ReasoningLevel: off | on | stream)

| Site | Layer | What it gates | Evidence |
|---|---|---|---|
| Definition | config | session-level setting, type `ReasoningLevel` | `src/config/sessions/types.ts:288` (`reasoningLevel?: string`) |
| TUI command | gateway/UI | `/reasoning` slash command sets session entry | `src/tui/tui-command-handlers.ts:571` |
| READ - status line | gateway | shows "Reasoning: X" in `/status` | `src/status/status-message.ts:824-826,906` |
| READ - system prompt | core-payload | tells model reasoning is on/stream | `src/agents/system-prompt.ts:882,982,1313` |
| GATE - subscribe state derivation | core-payload (init) | `reasoningMode = params.reasoningMode ?? "off"`; derives `includeReasoning` and `streamReasoning` | `src/agents/embedded-agent-subscribe.ts:160,176-182` |
| GATE - **emission** of `stream:"thinking"` agent event | provider-adapter / core, **emission** | `emitReasoningStream()` early-returns unless `state.streamReasoning && params.onReasoningStream`; only then `emitAgentEvent({stream:"thinking", data:{text,delta}})` AND `onReasoningStream({text})` | `src/agents/embedded-agent-subscribe.ts:1139-1172` (gate at 1143, emit at 1160-1167 and 1169-1171) |
| GATE - inline `<think>` tag streaming | core, emission | `if (ctx.state.streamReasoning) { ctx.emitReasoningStream(...) }` | `src/agents/embedded-agent-subscribe.handlers.messages.ts:693,615` |
| GATE - final-reasoning reply-payload creation | core-payload | `reasoningText = ... assistantForPayload && params.reasoningLevel === "on" && params.thinkingLevel !== "off" ? extractAssistantThinking(...) : ""`; only then `replyItems.push({text, isReasoning:true})` | `src/agents/embedded-agent-runner/run/payloads.ts:389-397` |
| GATE - CLI backend reasoning text -> `onReasoningStream` | provider-adapter (CLI) | unconditional forward of CLI `onReasoningText` to `opts.onReasoningStream` (no `streamReasoning` re-check here; gating already happened at CLI projector / `reasoningMode`) | `src/auto-reply/reply/agent-runner-execution.ts:2135-2137` |
| GATE - Discord primary delivery, **drop #1** (pre-delivery hook) | channel | `beforeDiscordPayloadDelivery`: `if (payload.isReasoning) return null` (skips before send, used for `kind: "block"` and `"final"`) | `extensions/discord/src/monitor/message-handler.process.ts:602-613` |
| GATE - Discord primary delivery, **drop #2** (delivery fn) | channel | `deliverDiscordPayload`: `if (payload.isReasoning) return {visibleReplySent:false}` | `extensions/discord/src/monitor/message-handler.process.ts:645-656` |
| GATE - generic dispatch `onBlockReply` (WhatsApp/web/etc, Discord block-reply lane too) | channel (shared dispatch) | `if (payload.isReasoning === true) return` (comment: "channels using this generic dispatch path do not have a dedicated reasoning lane") | `src/auto-reply/reply/dispatch-from-config.ts:2839` (related non-dedupe check at 2825) |
| GATE - dispatch-from-config final replies array | channel (shared dispatch) | `if (reply.isReasoning === true) continue` before any delivery, with comment "Suppress reasoning payloads from channel delivery" | `src/auto-reply/reply/dispatch-from-config.ts:3005-3009` |
| GATE - followup/queued origin routing | channel (shared, **followup path**) | `routeReply()`: `if (shouldSuppressReasoningPayload(payload)) return {ok:true}` -> `shouldSuppressReasoningPayload = payload.isReasoning===true` | `src/auto-reply/reply/route-reply.ts:104` + `src/auto-reply/reply/reply-payloads-base.ts:92-94` |
| GATE - infra outbound payload normalization | gateway/infra | same `shouldSuppressReasoningPayload` check before outbound send | `src/infra/outbound/payloads.ts:207` |
| GATE - webchat media/chat gateway methods | gateway | `if (payload.isReasoning === true)` short-circuits webchat reply assembly (3 sites) | `src/gateway/server-methods/chat-webchat-media.ts:239,266`; `src/gateway/server-methods/chat.ts:358,692,771` |
| GATE - heartbeat runner | gateway/infra | strips `isReasoning` flag / requires formatted prefix before delivering heartbeat payloads | `src/infra/heartbeat-runner.ts:751,761` |
| GATE - onReasoningStream wiring to Discord draft | channel | `onReasoningStream: async (payload) => { await statusReactions.setThinking(); await draftPreview.pushReasoningProgress(payload?.text, {snapshot: payload?.isReasoningSnapshot===true}) }` | `extensions/discord/src/monitor/message-handler.process.ts:1013-1018` |
| GATE - Discord draft push, mode check | channel | `pushReasoningProgress` no-ops unless `params.active && params.mode === "progress"` | `src/channels/progress-draft-compositor.ts:213-222` |

**Distinct gate sites for `/reasoning`/`reasoningLevel`/`thinkingLevel`/`streamReasoning`: 13** (counting the two Discord primary-path drops separately, the dispatch-from-config generic drop, the dispatch-from-config final-array drop, the followup `routeReply` drop, the infra outbound drop, the 3 gateway webchat/chat drops as one cluster, heartbeat-runner, and the 3 emission/creation gates in embedded-agent-subscribe/payloads.ts).

### Primary vs followup/queued path for `isReasoning` final payloads — VERIFIED

- **Primary path** (turn initiated directly from a channel message, delivered via `dispatchChannelInboundReply` -> `dispatchReplyWithBufferedBlockDispatcher`): payloads pass through Discord's own `beforeDiscordPayloadDelivery` (line 602) and `deliverDiscordPayload` (line 645) — **both** hard-drop `isReasoning` payloads with a `formatDiscordReplySkip` verbose log ("reasoning payload").
- **Followup/queued path** (`createFollowupRunner` in `src/auto-reply/reply/followup-runner.ts`, used when a turn is queued and later drained): `sendFollowupPayloads()` filters `sendablePayloads` only via `hasOutboundReplyContent(payload) && !deliveryPlan.isSilentPayload(payload)` (**no `isReasoning` check** at `followup-runner.ts:293-296`). It then routes either:
  - **origin route** -> `routeReply()` -> `shouldSuppressReasoningPayload(payload)` at `route-reply.ts:104` **does** drop it (returns `{ok:true}`, silent no-op — different code path, same net effect as Discord's drop, but with NO verbose "reasoning payload" log);
  - **dispatcher route** -> `opts.onBlockReply(payload)` directly (`followup-runner.ts:319`) which is `dispatch-from-config.ts`'s `onBlockReply` — that **does** check `payload.isReasoning === true` at `dispatch-from-config.ts:2839` and drops.

  So both final reasoning payloads are dropped on both primary and followup paths, but via **three different gate implementations** with different logging/observability (Discord-specific verbose skip log vs. silent `routeReply` no-op vs. dispatch-from-config silent return). PROPOSAL.md's claim that followup "bypasses the check" is **not quite right for the final `isReasoning` reply payload** — it is gated, just via `routeReply`/`shouldSuppressReasoningPayload` instead of Discord's `message-handler.process.ts:602/645`. The real divergence is in the **streaming** lane (see below), and in **observability** (followup drops are silent, primary drops are logged).

- **Streaming lane (`onReasoningStream` / `stream:"thinking"`)**: both primary and followup runs wire `onReasoningStream: params.opts?.onReasoningStream` identically through `agent-runner-execution.ts:2373-2386` (shared helper used by `createFollowupRunner` too), which forwards to Discord's `onReasoningStream` at `message-handler.process.ts:1013-1018` -> `draftPreview.pushReasoningProgress`. The function is the same object for both paths; divergence (if any) is in whether `draftPreview`/`draftStream` is an **active, in-progress-mode draft** for a followup turn — followup turns may run with `draftPreview.isProgressMode` false/absent (no live draft message), in which case `pushReasoningProgress` silently returns `false` at `progress-draft-compositor.ts:215-221` (`!params.active || params.mode !== "progress"`). This is a **draft-availability** divergence, not a code-path-skips-the-gate divergence.

### `/verbose` -> `toolVerbose` / `verboseLevel`

| Site | Layer | What it gates | Evidence |
|---|---|---|---|
| READ - run context verbose level | gateway | `resolveToolVerboseLevel(runId, sessionKey)` reads `getAgentRunContext(runId)?.verboseLevel`, normalized, default `"off"` | `src/gateway/server-chat.ts:932-936` |
| GATE - channel tool payload trimming | gateway | `channelToolPayload`: when `toolVerbose !== "full"`, strips `data.result`/`data.partialResult` before forwarding tool event | `src/gateway/server-chat.ts:1001,1007-1015` |
| GATE - node/channel tool-event forwarding | gateway | `if (isControlUiVisible && isToolEvent && !suppressHeartbeatToolEvents && toolVerbose !== "off") sendNodeAgentPayload(...)` | `src/gateway/server-chat.ts:1151-1158` (proposal cited 1152 — actual conditional spans 1151-1156, the `toolVerbose !== "off"` test is line 1155) |
| GATE - inline tool result reply payloads | core-payload | `inlineToolResults = params.inlineToolResultsAllowed && params.verboseLevel !== "off" && params.toolMetas.length > 0` | `src/agents/embedded-agent-runner/run/payloads.ts:365-367` |
| GATE - Discord durable verbose progress / draft commentary yield | channel | `verboseProgressActive()` callback set via `onVerboseProgressVisibility`, used to suppress draft commentary while durable verbose lane is active (local patches `0e8f0f542a7`, `0bdb54feff8` per PROPOSAL — not independently re-verified, file not found under that name in tree) | `extensions/discord/src/monitor/message-handler.process.ts:560-563,1010-1012` |

**Distinct gate sites for `/verbose`/`toolVerbose`/`verboseLevel`: 5** (2 gateway, 1 core-payload, 1 channel cluster, plus the read site).

### Other flags found

| Flag | Definition | Layer | Effect | Evidence |
|---|---|---|---|---|
| `thinkingLevel` (ThinkLevel: off/low/medium/high/max/adaptive) | session/provider option | provider-adapter | Maps to provider reasoning-effort params (OpenAI `reasoning.effort`, Anthropic budget, Google `thinkingConfig.thinkingLevel`, Moonshot/Minimax/proxy wrappers); also gates `canShowReasoning = thinkingLevel !== "off"` which feeds `includeReasoning`/`streamReasoning` derivation | `src/agents/embedded-agent-subscribe.ts:161`; provider maps in `src/llm/providers/*.ts` and `src/llm/providers/stream-wrappers/*.ts` |
| `includeReasoning` | derived state | core-payload | `reasoningMode === "on" && canShowReasoning`; used at `embedded-agent-subscribe.handlers.messages.ts:915` to decide whether thinking text is retained for final reply text vs. dropped | `src/agents/embedded-agent-subscribe.ts:177`; `embedded-agent-subscribe.handlers.messages.ts:915,1135` |
| `shouldEmitPartialReplies` | derived state | core-payload | `!(reasoningMode === "on" && !params.onBlockReply)` — when reasoning is "on" (not "stream") and there's no block-reply sink, partial replies are suppressed | `src/agents/embedded-agent-subscribe.ts:178` |
| `silentExpected` | run param | core, emission | `emitReasoningStream` early-returns if `params.silentExpected` (heartbeat/silent turns never stream thinking even if `streamReasoning` true) | `src/agents/embedded-agent-subscribe.ts:1140-1142` |
| `suppressHeartbeatToolEvents` | gateway | gateway | Independently gates tool-event forwarding regardless of `toolVerbose`; respected in mirror per PROPOSAL risk note | `src/gateway/server-chat.ts:1002-1003,1042,1063,1078,1090` |
| `disableBlockStreaming` (block-streaming mode) | dispatch option | channel | `disableBlockStreaming: sourceRepliesAreToolOnly ? true : (draftPreview.disableBlockStreamingForDraft ?? !resolvedBlockStreamingEnabled)` — Discord-side block streaming toggle, separate from `streamReasoning` | `extensions/discord/src/monitor/message-handler.process.ts:987-992` |
| `blockReplyBreak` / `blockReplyChunking` | run param | core, emission | Controls when `emitBlockChunk` fires (text_end vs other), independent of reasoning gates | `src/agents/embedded-agent-subscribe.ts:175`; passed through `agent-runner-execution.ts:2357-2358` |
| `deferBlockReplyDelivery` | derived state | core | `typeof params.onBeforeTerminalDelivery === "function"` — defers block-reply delivery until terminal callback fires; orthogonal to reasoning/verbose | `src/agents/embedded-agent-subscribe.ts:194` |
| `commentaryProgressEnabled` | dispatch option | channel | Discord-only: `draftPreview.isProgressMode ? draftPreview.commentaryProgressEnabled : undefined` — gates whether commentary lines render in the activity draft (separate from `/verbose`) | `src/auto-reply/reply/dispatch-from-config.ts:1007-1009` |
| Telegram `streamReasoningDraft` / `streamReasoningInProgressDraft` | channel-local | channel | Telegram-specific re-derivation of reasoning-stream gating for its draft modes (own dispatch path, "handles reasoning splitting" per comment at `dispatch-from-config.ts:2838`) | `extensions/telegram/src/bot-message-dispatch.ts:846,900-903,2020-2030` |

---

## 2. ADAPTER EMIT/DROP INVENTORY

### Embedded (src/agents/embedded-agent-subscribe.ts + embedded-agent-runner/run pipeline)

| Lane | Emits as agent event | Routes into reply payload | Drops |
|---|---|---|---|
| Final text (assistant visible) | `stream:"assistant"` via block-reply chunking (`emitBlockChunk`) when streaming partials | Yes — `assistantForPayload` -> `extractAssistantVisibleText` -> reply text | — |
| Thinking/reasoning | `stream:"thinking"`, `data:{text, delta}` — **ONLY** at `embedded-agent-subscribe.ts:1162`, gated `streamReasoning && onReasoningStream` (see §1) | Yes, separately: `reasoningLevel==="on" && thinkingLevel!=="off"` -> `payloads.ts:396` pushes `{text, isReasoning:true}` | If `streamReasoning` false: no `stream:"thinking"` event at all (silent); if `reasoningLevel!=="on"` or `thinkingLevel==="off"`: no reasoning reply payload either |
| Commentary/narration (inter-tool assistant text, phase `"commentary"`) | **NONE** — `if (deliveryPhase === "commentary") return;` short-circuits before any emission | **NONE** — `shouldSuppressAssistantVisibleOutput` returns true for commentary phase, suppressing visible output | Fully dropped — verified at `src/agents/embedded-agent-subscribe.handlers.messages.ts:678-680` and `:45-47` |
| Tool calls | `stream:"tool"` lifecycle events (start/result) via runner's standard tool-event emission (not file-line audited in this pass — out of scope given budget) | tool meta -> `toolMetas` -> inline tool result payloads when `verboseLevel !== "off"` (`payloads.ts:365-387`) | — |
| Usage | Embedded run records usage in run/session metadata (trajectory), not surfaced as a dedicated `stream:"usage"` agent event in the files examined | n/a | Not verified further — TODO |
| Errors | `lastAssistantStopReason === "error"`/`"aborted"` -> `errorText` reply payload (`payloads.ts:320-363`) | Yes — `replyItems.push({text: errorText, isError:true})` | — |

### Claude CLI backend (src/agents/cli-backends.ts + agent-runner-execution.ts CLI lifecycle)

| Lane | Emits as agent event | Routes into reply payload | Drops |
|---|---|---|---|
| Final text | via `onAssistantText` -> `handlePartialForTyping` -> `opts.onPartialReply` (`agent-runner-execution.ts:2128-2134`) | Yes, via partial-reply pipeline | — |
| Thinking/reasoning | `onReasoningText` -> `params.opts?.onReasoningStream?.({text})` (`agent-runner-execution.ts:2135-2137`) — **no** direct `emitAgentEvent({stream:"thinking"})` call in this file; relies on whatever `onReasoningStream` is bound to downstream | Downstream `onReasoningStream` (Discord draft, etc.) | If `opts.onReasoningStream` undefined, CLI reasoning text is dropped entirely — no `stream:"thinking"` fallback exists in the CLI lifecycle path |
| Commentary/narration | CLI backend (Claude CLI specifically) not separately audited for commentary-phase emission in this pass — TODO | — | — |
| Tool calls | `onToolEvent` -> `cliToolSummaryTracker.noteToolEvent` + `opts?.onToolStart` (`agent-runner-execution.ts:2138-2153`) | Tool summary payloads via `onToolResult` | — |
| Errors | `onErrorBeforeLifecycle` rollback hook (`agent-runner-execution.ts:2154+`) | via run result -> `buildEmbeddedRunPayloads` error path (shared with embedded) | — |

### Codex (extensions/codex/src/app-server/event-projector.ts)

| Lane | Emits as agent event | Routes into reply payload | Drops |
|---|---|---|---|
| Final text | Standard item events for `final_answer`-phase assistant items via `shouldStreamAssistantPartial` (phase `"final_answer"`) -> `emitStandardItemEvent`-family (`event-projector.ts:1006-1008,1032+`) | via final reply path | — |
| Thinking/reasoning | `handleReasoningDelta` -> `params.onReasoningStream?.({text: <accumulated>, isReasoningSnapshot:true})` — **snapshot, not delta** (`event-projector.ts:498-530`); **no** `emitAgentEvent({stream:"thinking"})` | via `onReasoningStream` callback (same wiring as CLI backend) | If `onReasoningStream` unset: dropped (no agent-event fallback) |
| Commentary/narration (phase `"commentary"` raw assistant items) | `emitCommentaryProgress({itemId, text})` -> `emitAgentEvent({stream:"item", data:{kind:"preamble", title:"Preamble", phase:"update", progressText, source:"codex-app-server"}})` (`event-projector.ts:878-879,1010-1029`) — **CONTRACT MISMATCH**: contract (`agent-event-io-contract-f92c1bf.md` Provider mapping guide) prescribes `stream:"assistant", phase:"commentary"` for Harmony commentary; Codex instead emits `stream:"item", kind:"preamble"` | Not into `assistant`-phase reply payloads; surfaces only as an `item`/preamble activity row | — |
| Tool calls | `emitStandardItemEvent` for tool/command items (start/end) | tool progress rows | — |
| Usage | not audited this pass — TODO | | |
| Errors | not audited this pass — TODO | | |

### ACP (src/acp/translator.ts, translator.session-updates.ts, event-mapper.ts)

| Lane | Emits as agent event | Routes into reply payload | Drops |
|---|---|---|---|
| Final text | ACP `agent_message_chunk` session-update, translated directly to ACP protocol (client-facing), not into the OpenClaw `stream:"assistant"` agent-event bus in the files inspected | ACP client receives natively | — |
| Thinking/reasoning | ACP `agent_thought_chunk` session-update emitted directly (`translator.ts:1116`, `translator.replay.ts:14,57`) — **no** `emitAgentEvent({stream:"thinking"})` or `onReasoningStream` call found in `translator.session-updates.ts` or `event-mapper.ts` | Goes to ACP client via native protocol, not to OpenClaw channel-session subscribers | For non-ACP channel subscribers (e.g. a Discord session bound to an ACP-backed agent), thinking content is **not mirrored** — grep for `stream:"thinking"`/`onReasoningStream` in `src/acp/*.ts` returned no hits outside test files |
| Commentary/narration | not found as `stream:"assistant", phase:"commentary"` in `event-mapper.ts`/`translator.session-updates.ts` — TODO confirm via `agent_message_chunk` phase tagging | | |
| Tool calls | ACP `tool_call`/`tool_call_update` session-updates | | |
| Usage/Errors | not audited this pass — TODO | | |

**Seed verification**: `stream:"thinking"` via `emitAgentEvent` is emitted **only** at `embedded-agent-subscribe.ts:1162`, confirmed — no other `emitAgentEvent({stream: "thinking"...})` call found in `extensions/codex`, `src/acp`, or CLI backend paths; those paths use `onReasoningStream` callback directly instead. Embedded path emits **no** commentary-phase events — confirmed at `embedded-agent-subscribe.handlers.messages.ts:678-680`.

---

## 3. CHANNEL CAPABILITY SURVEY

### Discord (extensions/discord)

- **Streamed edits/drafts**: yes — `message-handler.draft-preview.ts` wraps `src/channels/progress-draft-compositor.ts`; supports `pushToolProgress`, `pushReasoningProgress`, `updateFromPartial`, edit-throttled via Discord rate limits. Draft finalized into a durable message on final reply (`message-handler.process.ts:702-854`, `deliverWithFinalizableLivePreviewAdapter`).
- **Durable activity rows**: tool/commentary lines composed into the single in-place-edited draft message (one message per turn), not separate durable rows per item — `progress-draft-compositor.ts`, `progress-draft-lines.ts`.
- **Collapse/threads**: no native collapse; PROPOSAL notes `||spoiler||`/threads as alternatives, blockquote as pragmatic default for `/reasoning on` (not yet implemented per repo search — `pushReasoningProgress` exists but no blockquote/🧠-prefix formatting found in `progress-draft-compositor.ts`/`progress-draft-lines.ts` in this pass).
- **Reasoning display**: `/reasoning on|stream` -> `onReasoningStream` -> `draftPreview.pushReasoningProgress` (gated by `params.active && params.mode==="progress"`, `progress-draft-compositor.ts:213-222`); final `isReasoning` reply payloads are hard-dropped before delivery (`message-handler.process.ts:602,645`) — reasoning is currently **only** visible via the streaming draft lane, never as a durable final message.
- Key files: `extensions/discord/src/monitor/message-handler.process.ts`, `message-handler.draft-preview.ts`, `reply-delivery.ts`, `reply-safety.ts`.

### Control UI (ui/src/ui)

- **Streamed edits/drafts**: yes — `ui/src/ui/views/chat.ts` renders live `stream` deltas; `ui/src/ui/controllers/chat.ts` / `chat-model` manage streaming state.
- **Durable activity rows**: Control UI is the "visible Control UI" subscriber class in the gateway mirror contract — receives all `stream:"item"`/`tool` events live, rendered as activity cards (`server-chat.ts:1060-1106` broadcasts to `runToolRecipients`/`sessionEventSubscribers`).
- **Collapse/threads**: session-scoped event subscriptions (`session.tool`, etc.) allow attach-after-start; UI renders pending tool cards.
- **Reasoning display**: `showReasoning = props.showThinking && reasoningLevel !== "off"` (`ui/src/ui/views/chat.ts:1537-1538`); reads `activeSession?.reasoningLevel` from session config (`config-quick.ts` exposes `thinkingLevels` selector, `ui/src/ui/views/config-quick.ts`). Receives `stream:"thinking"` events directly since Control UI is the primary subscriber for embedded's only thinking-emission site.
- Key files: `ui/src/ui/views/chat.ts`, `ui/src/ui/controllers/chat.ts`, `ui/src/ui/views/config-quick.ts`, `ui/src/ui/types.ts`.

### TUI (src/tui)

- **Streamed edits/drafts**: TUI renders agent run status; `src/tui/tui.ts:1199` reads `sessionInfo.reasoningLevel ?? "off"` for status display.
- **Durable activity rows**: TUI session list/status views (`tui-session-actions.ts`, `tui-types.ts:64`) track `reasoningLevel` per session entry for display in `/status`-style summaries, not full activity-row rendering.
- **Collapse/threads**: not applicable — TUI is single-pane; no thread/collapse model found.
- **Reasoning display**: status-line only ("Reasoning: X"), via `src/commands/status.summary.ts:77,337` and `src/commands/sessions-table.ts:55,129` (`reasoning:<level>` tag in session table). No live thinking-stream rendering found in TUI files.
- Key files: `src/tui/tui.ts`, `src/tui/tui-session-actions.ts`, `src/tui/tui-command-handlers.ts`, `src/tui/tui-backend.ts`.

### ClickClack references

- ClickClack is referenced only in the **contract doc** (`agent-event-io-contract-f92c1bf.md`) as the motivating regression case (hidden-session commentary mirror) and in the channel-output-kinds table (`kind:"message"`/`"agent_commentary"`/`"agent_tool"`). No `ClickClack`-named source files found under `src/` or `extensions/` in this repo snapshot — ClickClack appears to be an external/upstream channel not present in this branch's tree (consistent with PROPOSAL.md building "on #92216" as an upstream dependency).

---

## Open TODOs / not fully verified this pass

- Embedded usage/error agent-event emission (lane completeness for "usage" and "errors" columns).
- Claude CLI backend commentary-phase handling (separate from embedded's `deliveryPhase==="commentary"` short-circuit).
- ACP commentary-phase mapping in `event-mapper.ts`/`translator.session-updates.ts`.
- Discord blockquote/🧠-prefix reasoning formatting — not found in current `progress-draft-compositor.ts`/`progress-draft-lines.ts`; PROPOSAL Layer 4 describes this as not-yet-built, consistent with absence.
- Local patches `0e8f0f542a7`, `0bdb54feff8` referenced in PROPOSAL.md could not be located by content search in this pass (may be patch-file names under `patches/` not grep'd, or already-applied diffs without a literal hash string in source).
