# TUI + GUI surface verification (2026-06-12 night, build: gateway13)

## TUI smoke (Class: gateway chat consumer — S1/S2)

Setup: pmac, tmux session `tuitest` (left running), `node openclaw.mjs tui`
with OPENCLAW_HOME=~/openclaw-sandbox-home against sandbox gateway
ws://127.0.0.1:19789, agent main / session main, deepseek-v4-flash.

Turn 1 (tool call): "Use your exec tool to run: echo tui-smoke-test &&
uname -s." → PASS. Tool executed, output block rendered, final answer
rendered, no errors (stderr empty). Pane capture excerpt:

    Use your exec tool to run: echo tui-smoke-test && uname -s. Then state the output.
    Output:
    ```
      tui-smoke-test
      Darwin
    ```
    All good — shell works, this is macOS.

Turn 2 (/reasoning): `/reasoning on` accepted — "reasoning set to on", status
bar gained `reasoning` chip (`… think low | reasoning | tokens 22k/1.0m`).
Follow-up turn rendered normally.

Archive proof (session 00000000-0000-0000-0000-000000000000.jsonl):
assistant messages = `thinking,toolCall` then `text,thinking` — all lanes
archived through the TUI path on tonight's build.

## Why the S3 gate cannot break TUI/GUI (code evidence)

- src/gateway/server-chat.ts:852 — gateway chat classifies S1 events:
  `if (evt.stream === "thinking") return "thinking"` (own throttle lane;
  consumes the bus, not reply payloads).
- src/gateway/chat-display-projection.ts:296 — history entries carry a
  `thinking` string (truncated for display; `thinkingSignature` deleted).
- ui/src/ui/chat/message-extract.ts:54 — control-UI extracts
  `content[].type === "thinking"` blocks from message objects (S2).
⇒ TUI + control-UI reasoning display rides S1/S2 only. The
reasoningPayloadsEnabled gate exists purely on the S3 channel-payload lane.
Emit-always made S1/S2 strictly more complete; no consumer change needed.

## Not yet verified (needs tomorrow / Peter or browser)

- control-UI visual check in a real browser (screenshot) — code-level proof
  only tonight. Discord interactive rounds (verbose-yield, lane purity,
  collapse summary counts) need a human #dev_test message; sandbox bot cannot
  message itself.
