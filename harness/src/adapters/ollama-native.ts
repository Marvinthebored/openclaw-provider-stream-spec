import { AdapterContext, asNumber, asString, isRecord } from "../adapter-context.ts";
import type { Adapter, InputFrame, NormalizedEvent } from "../types.ts";

type ToolState = {
  id?: string;
  index: number;
  name?: string;
  arguments?: unknown;
  ended: boolean;
};

export const ollamaNativeAdapter: Adapter = {
  id: "ollama-native",
  normalize(frames) {
    const normalizer = new OllamaNativeNormalizer(frames);
    return normalizer.run();
  }
};

class OllamaNativeNormalizer {
  private readonly ctx: AdapterContext;
  private readonly frames: InputFrame[];
  private started = false;
  private sawProviderFrame = false;
  private terminalEmitted = false;
  private model: string | undefined;
  private text = "";
  private thinkingOpen = false;
  private thinkingEnd: Extract<NormalizedEvent, { stream: "thinking" }> | undefined;
  private usage: unknown;
  private readonly tools: ToolState[] = [];

  constructor(frames: InputFrame[]) {
    this.frames = frames;
    this.ctx = new AdapterContext(frames);
  }

  run() {
    for (const frame of this.frames) {
      const before = this.ctx.dispositions.length;
      this.processFrame(frame);
      if (this.ctx.dispositions.length === before) {
        this.ctx.drop(frame, "empty_frame");
      }
    }
    this.finish();
    return this.ctx.result();
  }

  private processFrame(frame: InputFrame): void {
    if (frame.parseError || !isRecord(frame.data)) {
      this.ctx.diagnostic(frame, "parse_error", frame.parseError ?? frame.dataRaw);
      return;
    }
    if (this.terminalEmitted) {
      this.ctx.drop(frame, "post_terminal_frame");
      return;
    }
    this.sawProviderFrame = true;
    const chunk = frame.data;
    this.model = asString(chunk.model) ?? this.model;
    this.emitStart(frame);

    const message = isRecord(chunk.message) ? chunk.message : {};
    this.processThinking(frame, message);
    this.processContent(frame, message);
    this.processToolCalls(frame, message);

    if (chunk.done === true) {
      this.usage = ollamaUsage(chunk);
      this.emitTerminal(frame, asString(chunk.done_reason));
    }
  }

  private emitStart(frame: InputFrame): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.ctx.emit(frame, "lifecycle", {
      phase: "start",
      provider: "ollama",
      model: this.model
    });
  }

  private processThinking(frame: InputFrame, message: Record<string, unknown>): void {
    const thinking = asString(message.thinking);
    if (!thinking) {
      return;
    }
    if (!this.thinkingOpen) {
      this.thinkingOpen = true;
      this.ctx.emit(frame, "thinking", {
        variant: "raw",
        phase: "start"
      });
    }
    this.ctx.emit(frame, "thinking", {
      variant: "raw",
      delta: thinking
    });
  }

  private processContent(frame: InputFrame, message: Record<string, unknown>): void {
    const content = asString(message.content);
    if (!content) {
      return;
    }
    this.closeThinking(frame);
    this.text += content;
    this.ctx.emit(frame, "assistant", {
      phase: "commentary",
      delta: content,
      status: "in_progress"
    });
  }

  private processToolCalls(frame: InputFrame, message: Record<string, unknown>): void {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0) {
      return;
    }
    this.closeThinking(frame);
    for (const call of calls) {
      if (!isRecord(call)) {
        this.ctx.diagnostic(frame, "malformed_tool_call", call);
        continue;
      }
      const fn = isRecord(call.function) ? call.function : {};
      const index = asNumber(fn.index) ?? this.tools.length;
      const tool: ToolState = {
        id: asString(call.id),
        index,
        name: asString(fn.name),
        arguments: fn.arguments,
        ended: false
      };
      this.tools.push(tool);
      this.ctx.emit(frame, "item", {
        phase: "start",
        id: tool.id,
        index,
        kind: "tool",
        name: tool.name,
        status: "in_progress",
        input: tool.arguments
      });
    }
  }

  private closeThinking(frame: InputFrame | undefined): void {
    if (!this.thinkingOpen || this.thinkingEnd) {
      return;
    }
    this.thinkingEnd = this.ctx.emit(frame, "thinking", {
      variant: "raw",
      phase: "end"
    });
  }

  private emitTerminal(frame: InputFrame, doneReason: string | undefined): void {
    this.closeThinking(frame);
    if (this.tools.length > 0) {
      this.endOpenTools(frame, doneReason === "error" ? "failed" : "completed");
      this.ctx.emit(frame, "lifecycle", {
        phase: doneReason === "error" ? "error" : "end",
        reason: doneReason === "error" ? "error" : "tool_use",
        status: doneReason === "error" ? "incomplete" : "completed",
        usage: this.usage
      });
      this.terminalEmitted = true;
      return;
    }

    if (doneReason === "length") {
      this.emitFinal(frame, true);
      this.ctx.emit(frame, "lifecycle", {
        phase: "end",
        reason: "truncated",
        status: "incomplete",
        usage: this.usage
      });
    } else if (doneReason === "error") {
      this.ctx.emit(frame, "lifecycle", {
        phase: "error",
        reason: "error",
        status: "incomplete",
        usage: this.usage
      });
    } else {
      this.emitFinal(frame, false);
      this.ctx.emit(frame, "lifecycle", {
        phase: "end",
        reason: "completed",
        status: "completed",
        usage: this.usage
      });
    }
    this.terminalEmitted = true;
  }

  private emitFinal(frame: InputFrame, truncated: boolean): void {
    if (!this.text) {
      return;
    }
    this.ctx.emit(frame, "assistant", {
      phase: "final_answer",
      text: this.text,
      status: "completed",
      ...(truncated ? { truncated: true } : {})
    });
  }

  private endOpenTools(frame: InputFrame, status: "completed" | "failed"): void {
    for (const tool of this.tools) {
      if (tool.ended) {
        continue;
      }
      tool.ended = true;
      this.ctx.emit(frame, "item", {
        phase: "end",
        id: tool.id,
        index: tool.index,
        kind: "tool",
        name: tool.name,
        status,
        arguments: tool.arguments
      });
    }
  }

  private finish(): void {
    if (this.terminalEmitted || !this.sawProviderFrame) {
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
}

function ollamaUsage(chunk: Record<string, unknown>): unknown {
  const usage: Record<string, unknown> = {};
  for (const key of [
    "done_reason",
    "total_duration",
    "load_duration",
    "prompt_eval_count",
    "prompt_eval_duration",
    "eval_count",
    "eval_duration"
  ]) {
    if (chunk[key] !== undefined) {
      usage[key] = chunk[key];
    }
  }
  return usage;
}
