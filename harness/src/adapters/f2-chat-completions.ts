import {
  AdapterContext,
  asNumber,
  asString,
  isRecord,
  parseMaybeJson
} from "../adapter-context.ts";
import type { Adapter, InputFrame, NormalizedEvent } from "../types.ts";

type TerminalPath = {
  phase: "end" | "error";
  reason:
    | "completed"
    | "truncated"
    | "tool_use"
    | "content_filter"
    | "error"
    | "stream_closed"
    | "incomplete";
  status: "completed" | "incomplete";
  diagnostic?: { code: string; detail?: unknown };
};

type ToolState = {
  index: number;
  id?: string;
  name?: string;
  argumentsText: string;
  ended: boolean;
};

type ThinkingSegment = {
  key: string;
  variant: "raw" | "summary" | "redacted";
  id?: string;
  hasDisplayable: boolean;
  sawOpaque: boolean;
  open: boolean;
  endEvent?: Extract<NormalizedEvent, { stream: "thinking" }>;
};

export const f2ChatCompletionsAdapter: Adapter = {
  id: "f2",
  normalize(frames) {
    const normalizer = new F2Normalizer(frames);
    return normalizer.run();
  }
};

class F2Normalizer {
  private readonly ctx: AdapterContext;
  private readonly frames: InputFrame[];
  private readonly tools = new Map<number, ToolState>();
  private readonly structuredThinking = new Map<string, ThinkingSegment>();
  private text = "";
  private refusal = "";
  private usage: unknown;
  private terminalPath: TerminalPath | undefined;
  private terminalEmitted = false;
  private flatThinkingOpen = false;
  private flatThinkingEnd: Extract<NormalizedEvent, { stream: "thinking" }> | undefined;

  constructor(frames: InputFrame[]) {
    this.frames = frames;
    this.ctx = new AdapterContext(frames);
    this.ctx.observed.sawDone = false;
  }

  run() {
    for (const frame of this.frames) {
      const before = this.ctx.dispositions.length;
      this.processFrame(frame);
      if (this.ctx.dispositions.length === before) {
        this.ctx.drop(frame, "empty_chunk");
      }
    }
    this.finish();
    return this.ctx.result();
  }

  private processFrame(frame: InputFrame): void {
    if (frame.comment) {
      this.ctx.drop(frame, "sse_comment");
      return;
    }
    if (frame.done) {
      this.ctx.observed.sawDone = true;
      this.ctx.drop(frame, "done_sentinel");
      return;
    }
    if (frame.parseError || !isRecord(frame.data)) {
      this.ctx.diagnostic(frame, "parse_error", frame.parseError ?? frame.dataRaw);
      return;
    }

    const chunk = frame.data;
    this.captureUsage(frame, chunk);

    if ("error" in chunk && chunk.error !== undefined && chunk.error !== null) {
      this.closeThinking(frame);
      this.terminalPath = {
        phase: "error",
        reason: "error",
        status: "incomplete",
        diagnostic: { code: "provider_error", detail: chunk.error }
      };
      this.emitTerminal(frame);
      return;
    }

    if ("x_pioneer" in chunk) {
      this.ctx.emit(frame, "lifecycle", {
        phase: "update",
        diagnostic: { code: "pioneer_metadata", detail: chunk.x_pioneer }
      });
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0) {
      if (chunk.usage !== undefined && chunk.usage !== null) {
        this.ctx.drop(frame, "usage_only_chunk");
      }
      return;
    }

    for (const choice of choices) {
      if (!isRecord(choice)) {
        this.ctx.diagnostic(frame, "malformed_choice", choice);
        continue;
      }
      this.captureUsage(frame, choice);
      const delta = isRecord(choice.delta) ? choice.delta : {};
      this.captureUsage(frame, delta);

      if (this.terminalPath) {
        this.ctx.drop(frame, "post_terminal_choice");
        continue;
      }

      this.processDelta(frame, delta);
      const finishReason = asString(choice.finish_reason);
      if (finishReason) {
        this.dispatchFinish(frame, finishReason, choice);
      }
    }
  }

  private processDelta(frame: InputFrame, delta: Record<string, unknown>): void {
    if (asString(delta.role)) {
      this.ctx.drop(frame, "role_announcement");
    }

    this.processReasoning(frame, delta);
    this.processContent(frame, delta.content);

    const refusal = asString(delta.refusal);
    if (refusal) {
      this.refusal += refusal;
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const call of toolCalls) {
      if (isRecord(call)) {
        this.processToolCall(frame, call);
      } else {
        this.ctx.diagnostic(frame, "malformed_tool_call", call);
      }
    }

    if (isRecord(delta.function_call)) {
      this.processLegacyFunctionCall(frame, delta.function_call);
    }
  }

  private processContent(frame: InputFrame, content: unknown): void {
    if (content === null || content === undefined || content === "") {
      return;
    }
    if (typeof content === "string") {
      this.text += content;
      this.ctx.emit(frame, "assistant", {
        phase: "commentary",
        delta: content,
        status: "in_progress"
      });
      return;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part)) continue;
        const type = asString(part.type);
        const text = asString(part.text) ?? asString(part.output_text) ?? asString(part.content);
        if ((type === "text" || type === "output_text") && text) {
          this.text += text;
          this.ctx.emit(frame, "assistant", {
            phase: "commentary",
            delta: text,
            status: "in_progress"
          });
        } else if ((type === "thinking" || type === "reasoning") && text) {
          this.emitFlatThinking(frame, text);
        }
      }
      return;
    }
    this.ctx.diagnostic(frame, "unsupported_content_shape", content);
  }

  private processReasoning(frame: InputFrame, delta: Record<string, unknown>): void {
    const details = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : undefined;
    if (details) {
      for (const entry of details) {
        if (isRecord(entry)) {
          this.processReasoningDetail(frame, entry);
        } else {
          this.ctx.diagnostic(frame, "malformed_reasoning_detail", entry);
        }
      }
      return;
    }

    const flat =
      asString(delta.reasoning_content) ??
      asString(delta.reasoning) ??
      asString(delta.reasoning_text);
    if (flat) {
      this.emitFlatThinking(frame, flat);
    }
  }

  private processReasoningDetail(frame: InputFrame, entry: Record<string, unknown>): void {
    const type = asString(entry.type);
    const key = reasoningDetailKey(entry);
    const segment = this.structuredThinking.get(key) ?? {
      key,
      variant: "redacted" as const,
      id: asString(entry.id),
      hasDisplayable: false,
      sawOpaque: false,
      open: false
    };
    this.structuredThinking.set(key, segment);

    if ("signature" in entry) {
      this.ctx.recordTranscript(frame, "openrouter_reasoning_signature", entry.signature);
    }
    if ("data" in entry) {
      this.ctx.recordTranscript(frame, "openrouter_reasoning_encrypted", entry.data);
      segment.sawOpaque = true;
    }

    if (type === "reasoning.text") {
      const text = asString(entry.text);
      if (text) {
        segment.variant = "raw";
        this.emitStructuredThinking(frame, segment, text);
      } else if (!("signature" in entry)) {
        this.ctx.drop(frame, "empty_reasoning_text_detail");
      }
      return;
    }

    if (type === "reasoning.summary") {
      const summary = asString(entry.summary);
      if (summary) {
        segment.variant = "summary";
        this.emitStructuredThinking(frame, segment, summary);
      } else {
        this.ctx.drop(frame, "empty_reasoning_summary_detail");
      }
      return;
    }

    if (type === "reasoning.encrypted") {
      segment.sawOpaque = true;
      return;
    }

    if ("signature" in entry || "data" in entry) {
      segment.sawOpaque = true;
      return;
    }

    this.ctx.diagnostic(frame, "unknown_reasoning_detail", entry);
  }

  private emitStructuredThinking(frame: InputFrame, segment: ThinkingSegment, text: string): void {
    segment.hasDisplayable = true;
    if (!segment.open) {
      segment.open = true;
      this.ctx.emit(frame, "thinking", {
        ...(segment.id ? { id: segment.id } : {}),
        variant: segment.variant,
        phase: "start"
      });
    }
    this.ctx.emit(frame, "thinking", {
      ...(segment.id ? { id: segment.id } : {}),
      variant: segment.variant,
      delta: text
    });
  }

  private emitFlatThinking(frame: InputFrame, text: string): void {
    if (!this.flatThinkingOpen) {
      this.flatThinkingOpen = true;
      this.ctx.emit(frame, "thinking", {
        variant: "raw",
        phase: "start"
      });
    }
    this.ctx.emit(frame, "thinking", {
      variant: "raw",
      delta: text
    });
  }

  private processToolCall(frame: InputFrame, call: Record<string, unknown>): void {
    const index = asNumber(call.index) ?? 0;
    const fn = isRecord(call.function) ? call.function : {};
    let state = this.tools.get(index);
    const id = asString(call.id);
    const name = asString(fn.name);
    if (!state) {
      state = {
        index,
        id,
        name,
        argumentsText: "",
        ended: false
      };
      this.tools.set(index, state);
      this.ctx.emit(frame, "item", {
        phase: "start",
        id: state.id,
        index,
        kind: "tool",
        name: state.name,
        status: "in_progress"
      });
    } else {
      state.id ??= id;
      state.name ??= name;
    }

    const args = asString(fn.arguments);
    if (args) {
      state.argumentsText += args;
      this.ctx.emit(frame, "item", {
        phase: "update",
        id: state.id,
        index,
        kind: "tool",
        name: state.name,
        status: "in_progress",
        input_delta: args
      });
    }
  }

  private processLegacyFunctionCall(frame: InputFrame, fn: Record<string, unknown>): void {
    const call = {
      index: 0,
      id: "legacy_function_call",
      function: fn
    };
    this.processToolCall(frame, call);
  }

  private dispatchFinish(frame: InputFrame, finishReason: string, choice: Record<string, unknown>): void {
    this.closeThinking(frame);
    switch (finishReason) {
      case "stop":
        this.emitFinal(frame, false);
        this.terminalPath = {
          phase: "end",
          reason: "completed",
          status: "completed",
          diagnostic: finishDiagnostic(choice)
        };
        return;
      case "length":
        this.emitFinal(frame, true);
        this.terminalPath = {
          phase: "end",
          reason: "truncated",
          status: "incomplete",
          diagnostic: finishDiagnostic(choice)
        };
        return;
      case "content_filter":
        this.terminalPath = {
          phase: "error",
          reason: "content_filter",
          status: "incomplete",
          diagnostic: finishDiagnostic(choice)
        };
        return;
      case "tool_calls":
      case "function_call":
        this.endTools(frame);
        this.terminalPath = {
          phase: "end",
          reason: "tool_use",
          status: "completed",
          diagnostic: finishDiagnostic(choice)
        };
        return;
      case "error":
        this.terminalPath = {
          phase: "error",
          reason: "error",
          status: "incomplete",
          diagnostic: finishDiagnostic(choice) ?? { code: "finish_reason_error" }
        };
        return;
      default:
        this.terminalPath = {
          phase: "end",
          reason: "incomplete",
          status: "incomplete",
          diagnostic: { code: "unknown_finish_reason", detail: finishReason }
        };
    }
  }

  private emitFinal(frame: InputFrame, truncated: boolean): void {
    const text = this.text || this.refusal;
    if (!text) {
      return;
    }
    this.ctx.emit(frame, "assistant", {
      phase: "final_answer",
      text,
      status: "completed",
      ...(truncated ? { truncated: true } : {})
    });
  }

  private closeThinking(frame: InputFrame | undefined): void {
    if (this.flatThinkingOpen && !this.flatThinkingEnd) {
      this.flatThinkingEnd = this.ctx.emit(frame, "thinking", {
        variant: "raw",
        phase: "end"
      });
    }

    for (const segment of this.structuredThinking.values()) {
      if (segment.open && !segment.endEvent) {
        segment.endEvent = this.ctx.emit(frame, "thinking", {
          ...(segment.id ? { id: segment.id } : {}),
          variant: segment.variant,
          phase: "end"
        });
      } else if (!segment.hasDisplayable && segment.sawOpaque && !segment.endEvent) {
        this.ctx.emit(frame, "thinking", {
          ...(segment.id ? { id: segment.id } : {}),
          variant: "redacted",
          phase: "start"
        });
        segment.endEvent = this.ctx.emit(frame, "thinking", {
          ...(segment.id ? { id: segment.id } : {}),
          variant: "redacted",
          phase: "end"
        });
      }
    }
  }

  private endTools(frame: InputFrame): void {
    for (const state of this.tools.values()) {
      if (state.ended) continue;
      state.ended = true;
      this.ctx.emit(frame, "item", {
        phase: "end",
        id: state.id,
        index: state.index,
        kind: "tool",
        name: state.name,
        status: "completed",
        arguments: parseMaybeJson(state.argumentsText)
      });
    }
  }

  private captureUsage(frame: InputFrame, value: Record<string, unknown>): void {
    if (isRecord(value.usage)) {
      this.usage = value.usage;
      if ("choices" in value) {
        this.ctx.usage("top-level");
      } else if ("delta" in value || "finish_reason" in value) {
        this.ctx.usage("choice");
      } else {
        this.ctx.usage("delta");
      }
      this.backfillThinkingTokens();
      this.ctx.mark(frame, "documented-drop", "usage_captured");
    }
  }

  private backfillThinkingTokens(): void {
    if (!isRecord(this.usage)) return;
    const completion = isRecord(this.usage.completion_tokens_details)
      ? this.usage.completion_tokens_details
      : undefined;
    const output = isRecord(this.usage.output_tokens_details)
      ? this.usage.output_tokens_details
      : undefined;
    const tokens =
      asNumber(completion?.reasoning_tokens) ??
      asNumber(output?.reasoning_tokens);
    if (tokens === undefined) return;

    if (this.flatThinkingEnd) {
      this.flatThinkingEnd.data.tokens = tokens;
    }
    for (const segment of this.structuredThinking.values()) {
      if (segment.endEvent) {
        segment.endEvent.data.tokens = tokens;
      }
    }
  }

  private finish(): void {
    if (this.terminalEmitted) {
      return;
    }
    if (this.terminalPath) {
      this.emitTerminal(undefined);
      return;
    }
    this.closeThinking(undefined);
    this.ctx.observed.synthesizedStreamClosed = true;
    this.ctx.emit(undefined, "lifecycle", {
      phase: "error",
      reason: "stream_closed",
      status: "incomplete",
      usage: this.usage,
      diagnostic: { code: "stream_closed" }
    });
    this.terminalEmitted = true;
  }

  private emitTerminal(frame: InputFrame | undefined): void {
    if (!this.terminalPath || this.terminalEmitted) {
      return;
    }
    this.ctx.emit(frame, "lifecycle", {
      phase: this.terminalPath.phase,
      reason: this.terminalPath.reason,
      status: this.terminalPath.status,
      usage: this.usage,
      ...(this.terminalPath.diagnostic ? { diagnostic: this.terminalPath.diagnostic } : {})
    });
    this.terminalEmitted = true;
  }
}

function reasoningDetailKey(entry: Record<string, unknown>): string {
  const format = asString(entry.format) ?? "unknown";
  const index = entry.index === undefined || entry.index === null ? "absent" : String(entry.index);
  if (index !== "absent") {
    return `${format}:${index}`;
  }
  const id = asString(entry.id);
  if (id) {
    return `id:${id}`;
  }
  return `${format}:absent`;
}

function finishDiagnostic(choice: Record<string, unknown>): { code: string; detail?: unknown } | undefined {
  const native = asString(choice.native_finish_reason);
  if (!native) {
    return undefined;
  }
  return { code: "native_finish_reason", detail: native };
}
