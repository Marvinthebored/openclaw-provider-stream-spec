import { AdapterContext, asString, isRecord } from "../adapter-context.ts";
import type { Adapter, InputFrame } from "../types.ts";

// Codex app-server JSON-RPC envelope (Peter's main OpenAI transport in openclaw).
// Captures are server-stdout JSONL: RPC responses to initialize/thread\/start/turn\/start
// plus notifications. See evidence/codex-appserver-envelope.md §2 for the frame map.

type ItemPhase = "commentary" | "final_answer";

export const codexAppServerAdapter: Adapter = {
  id: "codex-appserver",
  normalize(frames) {
    const ctx = new AdapterContext(frames);
    const itemPhases = new Map<string, ItemPhase>();
    let latestUsage: unknown;
    let terminal = false;

    for (const frame of frames) {
      if (frame.parseError || !isRecord(frame.data)) {
        ctx.diagnostic(frame, "parse_error", frame.parseError ?? frame.dataRaw);
        continue;
      }
      const data = frame.data;

      if (data.id !== undefined && data.method === undefined) {
        handleRpcResponse(ctx, frame, data);
        continue;
      }

      const method = asString(data.method);
      const params = isRecord(data.params) ? data.params : {};
      const item = isRecord(params.item) ? params.item : undefined;

      switch (method) {
        case "thread/started":
          ctx.drop(frame, "thread_started_mirror");
          break;
        case "turn/started":
          ctx.drop(frame, "turn_started");
          break;
        case "thread/status/changed":
        case "mcpServer/startupStatus/updated":
        case "remoteControl/status/changed":
        case "account/rateLimits/updated":
          ctx.drop(frame, "operator_metadata");
          break;
        case "item/started":
          handleItemStarted(ctx, frame, item, itemPhases);
          break;
        case "item/agentMessage/delta": {
          const itemId = asString(params.itemId);
          ctx.emit(frame, "assistant", {
            phase: "commentary",
            delta: asString(params.delta) ?? "",
            id: itemId,
            status: "in_progress"
          });
          break;
        }
        case "item/reasoning/textDelta":
          ctx.emit(frame, "thinking", {
            variant: "raw",
            delta: asString(params.delta) ?? "",
            id: asString(params.itemId)
          });
          break;
        case "item/reasoning/summaryTextDelta":
          ctx.emit(frame, "thinking", {
            variant: "summary",
            delta: asString(params.delta) ?? "",
            id: asString(params.itemId)
          });
          break;
        case "item/commandExecution/outputDelta":
          ctx.emit(frame, "item", {
            phase: "update",
            id: asString(params.itemId),
            kind: "tool",
            name: "commandExecution",
            status: "in_progress",
            output_delta: asString(params.delta) ?? ""
          });
          break;
        case "item/completed":
          handleItemCompleted(ctx, frame, item, itemPhases);
          break;
        case "rawResponseItem/completed":
          if (item && asString(item.type) === "reasoning") {
            ctx.recordTranscript(frame, "codex_raw_reasoning", item);
          } else {
            ctx.drop(frame, "raw_mirror");
          }
          break;
        case "thread/tokenUsage/updated":
          latestUsage = params.tokenUsage;
          ctx.drop(frame, "usage_update");
          break;
        case "turn/completed": {
          const turn = isRecord(params.turn) ? params.turn : {};
          const failed = turn.error != null || asString(turn.status) === "failed";
          ctx.emit(frame, "lifecycle", {
            phase: failed ? "error" : "end",
            reason: failed ? "error" : "completed",
            status: failed ? "incomplete" : "completed",
            usage: latestUsage
          });
          terminal = true;
          break;
        }
        case "error":
          ctx.emit(frame, "lifecycle", {
            phase: "error",
            reason: "error",
            status: "incomplete",
            usage: latestUsage,
            diagnostic: { code: "codex_error", detail: params.error ?? params }
          });
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

function handleRpcResponse(ctx: AdapterContext, frame: InputFrame, data: Record<string, unknown>): void {
  const result = isRecord(data.result) ? data.result : undefined;
  if (result && isRecord(result.thread)) {
    ctx.emit(frame, "lifecycle", {
      phase: "start",
      provider: asString(result.modelProvider) ?? "codex-app-server",
      model: asString(result.model),
      id: asString(result.thread.id)
    });
    return;
  }
  if (isRecord(data.error)) {
    ctx.diagnostic(frame, "rpc_error", data.error);
    return;
  }
  ctx.drop(frame, "rpc_response");
}

function handleItemStarted(
  ctx: AdapterContext,
  frame: InputFrame,
  item: Record<string, unknown> | undefined,
  itemPhases: Map<string, ItemPhase>
): void {
  if (!item) {
    ctx.diagnostic(frame, "malformed_item_started");
    return;
  }
  const type = asString(item.type);
  const id = asString(item.id);
  if (type === "agentMessage" && id) {
    const phase = asString(item.phase) === "final_answer" ? "final_answer" : "commentary";
    itemPhases.set(id, phase);
    ctx.drop(frame, `agent_message_started_${phase}`);
    return;
  }
  if (type === "reasoning") {
    ctx.drop(frame, "reasoning_started");
    return;
  }
  if (type === "userMessage") {
    ctx.drop(frame, "input_echo");
    return;
  }
  // tool-shaped items: commandExecution, mcpToolCall, fileChange, webSearch, dynamicToolCall
  ctx.emit(frame, "item", {
    phase: "start",
    id,
    kind: "tool",
    name: type,
    status: "in_progress",
    input: asString(item.command) ?? item.invocation ?? undefined
  });
}

function handleItemCompleted(
  ctx: AdapterContext,
  frame: InputFrame,
  item: Record<string, unknown> | undefined,
  itemPhases: Map<string, ItemPhase>
): void {
  if (!item) {
    ctx.diagnostic(frame, "malformed_item_completed");
    return;
  }
  const type = asString(item.type);
  const id = asString(item.id);

  if (type === "agentMessage") {
    const phase = asString(item.phase) === "final_answer"
      ? "final_answer"
      : (id ? itemPhases.get(id) : undefined) ?? "commentary";
    ctx.emit(frame, "assistant", {
      phase,
      id,
      text: asString(item.text) ?? "",
      status: "completed"
    });
    return;
  }

  if (type === "reasoning") {
    const content = Array.isArray(item.content) ? item.content : [];
    const summary = Array.isArray(item.summary) ? item.summary : [];
    if (content.length === 0 && summary.length === 0) {
      // OAuth raw lane is encrypted-only; tokens arrive later via tokenUsage →
      // content-free redacted marker per SPEC §3.2 (token backfill on lifecycle usage)
      ctx.emit(frame, "thinking", { variant: "redacted", id });
      return;
    }
    if (summary.length > 0) {
      ctx.emit(frame, "thinking", {
        variant: "summary",
        id,
        text: summary.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join("")
      });
    }
    if (content.length > 0) {
      ctx.emit(frame, "thinking", {
        variant: "raw",
        id,
        text: content.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join("")
      });
    }
    return;
  }

  if (type === "userMessage") {
    ctx.drop(frame, "input_echo");
    return;
  }

  const failed = asString(item.status) === "failed" ||
    (typeof item.exitCode === "number" && item.exitCode !== 0);
  ctx.emit(frame, "item", {
    phase: "end",
    id,
    kind: "tool",
    name: type,
    status: failed ? "failed" : "completed",
    input: asString(item.command) ?? item.invocation ?? undefined,
    output: item.aggregatedOutput ?? item.output ?? undefined
  });
}
