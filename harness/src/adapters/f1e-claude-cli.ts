import {
  AdapterContext,
  asString,
  isRecord
} from "../adapter-context.ts";
import type { Adapter, InputFrame } from "../types.ts";
import { AnthropicStreamNormalizer } from "./f1-anthropic-sse.ts";

const innerOptions = {
  emitLifecycleStart: false,
  emitTerminal: false,
  emitFinalAnswer: false,
  synthesizeStreamClosed: false
};

export const f1eClaudeCliAdapter: Adapter = {
  id: "f1e",
  normalize(frames) {
    const ctx = new AdapterContext(frames);
    const inner = new AnthropicStreamNormalizer(ctx, innerOptions);
    let progressText = "";
    let terminal = false;

    for (const frame of frames) {
      if (frame.parseError || !isRecord(frame.data)) {
        ctx.diagnostic(frame, "parse_error", frame.parseError ?? frame.dataRaw);
        continue;
      }
      const data = frame.data;
      const type = asString(data.type);

      if (type === "stream_event") {
        const event = isRecord(data.event) ? data.event : undefined;
        const delta = isRecord(event?.delta) ? event.delta : undefined;
        if (asString(delta?.type) === "text_delta") {
          progressText += asString(delta?.text) ?? "";
        }
        if (event) {
          inner.processEvent(frame, event);
        } else {
          ctx.diagnostic(frame, "malformed_stream_event", data);
        }
        continue;
      }

      switch (type) {
        case "system":
          handleSystem(ctx, frame, data);
          break;
        case "rate_limit_event":
          ctx.emit(frame, "lifecycle", {
            phase: "update",
            diagnostic: {
              code: "rate_limit_event",
              detail: data.rate_limit_info
            }
          });
          break;
        case "assistant":
          handleAssistantSnapshot(ctx, frame, data);
          break;
        case "result":
          handleResult(ctx, frame, data, progressText, inner.latestUsage());
          terminal = true;
          break;
        default:
          ctx.diagnostic(frame, "unknown_frame", data);
      }
    }

    if (!terminal) {
      ctx.observed.synthesizedStreamClosed = true;
      ctx.emit(undefined, "lifecycle", {
        phase: "error",
        reason: "stream_closed",
        status: "incomplete",
        diagnostic: { code: "stream_closed" }
      });
    }

    return ctx.result();
  }
};

function handleSystem(ctx: AdapterContext, frame: InputFrame, data: Record<string, unknown>): void {
  const subtype = asString(data.subtype);
  if (subtype === "init") {
    ctx.emit(frame, "lifecycle", {
      phase: "start",
      provider: "claude-cli",
      model: asString(data.model),
      id: asString(data.session_id),
      diagnostic: {
        code: "claude_cli_init",
        detail: {
          cwd: data.cwd,
          claude_code_version: data.claude_code_version,
          permissionMode: data.permissionMode
        }
      }
    });
    return;
  }
  if (subtype === "status") {
    ctx.emit(frame, "lifecycle", {
      phase: "update",
      diagnostic: {
        code: "claude_cli_status",
        detail: { status: data.status }
      }
    });
    return;
  }
  ctx.diagnostic(frame, "unknown_system_frame", data);
}

function handleAssistantSnapshot(ctx: AdapterContext, frame: InputFrame, data: Record<string, unknown>): void {
  const message = isRecord(data.message) ? data.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  let recorded = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" && "signature" in block) {
      ctx.recordTranscript(frame, "claude_cli_snapshot_signature", block.signature);
      recorded = true;
    }
    if (block.type === "redacted_thinking" || "data" in block) {
      ctx.recordTranscript(frame, "claude_cli_snapshot_opaque_thinking", block);
      recorded = true;
    }
  }
  if (!recorded) {
    ctx.drop(frame, "assistant_snapshot");
  }
}

function handleResult(
  ctx: AdapterContext,
  frame: InputFrame,
  data: Record<string, unknown>,
  progressText: string,
  innerUsage: unknown
): void {
  const usage = data.usage ?? innerUsage;
  if (data.is_error === true) {
    ctx.emit(frame, "lifecycle", {
      phase: "error",
      reason: "error",
      status: "incomplete",
      usage,
      diagnostic: {
        code: "claude_cli_result_error",
        detail: {
          subtype: data.subtype,
          api_error_status: data.api_error_status
        }
      }
    });
    return;
  }

  const stopReason = asString(data.stop_reason);
  const finalText = asString(data.result) || progressText;

  if ((stopReason === "end_turn" || stopReason === "stop_sequence" || stopReason === "max_tokens") && finalText !== "") {
    ctx.emit(frame, "assistant", {
      phase: "final_answer",
      text: finalText,
      status: "completed",
      ...(stopReason === "max_tokens" ? { truncated: true } : {})
    });
  }

  if (stopReason === "refusal") {
    ctx.emit(frame, "lifecycle", {
      phase: "error",
      reason: "refusal",
      status: "incomplete",
      usage
    });
    return;
  }

  if (stopReason === "tool_use" || stopReason === "server_tool_use") {
    ctx.emit(frame, "lifecycle", {
      phase: "end",
      reason: "tool_use",
      status: "completed",
      usage
    });
    return;
  }

  if (stopReason === "pause_turn") {
    ctx.emit(frame, "lifecycle", {
      phase: "end",
      reason: "paused",
      status: "incomplete",
      usage
    });
    return;
  }

  ctx.emit(frame, "lifecycle", {
    phase: "end",
    reason: stopReason === "max_tokens" ? "truncated" : stopReason === "stop_sequence" ? "stop_sequence" : "completed",
    status: stopReason === "max_tokens" ? "incomplete" : "completed",
    usage
  });
}
