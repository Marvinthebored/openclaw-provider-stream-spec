import {
  AdapterContext,
  asString,
  isRecord,
  parseMaybeJson
} from "../adapter-context.ts";
import type { Adapter, InputFrame, NormalizedEvent } from "../types.ts";

type AnthropicOptions = {
  emitLifecycleStart: boolean;
  emitTerminal: boolean;
  emitFinalAnswer: boolean;
  synthesizeStreamClosed: boolean;
};

type ContentBlock = {
  index: number;
  type: string;
  id: string;
  name?: string;
  text: string;
  inputJson: string;
  thinkingStarted: boolean;
  thinkingEnd?: Extract<NormalizedEvent, { stream: "thinking" }>;
  sawSignature: boolean;
};

const directOptions: AnthropicOptions = {
  emitLifecycleStart: true,
  emitTerminal: true,
  emitFinalAnswer: true,
  synthesizeStreamClosed: true
};

export const f1AnthropicSseAdapter: Adapter = {
  id: "f1",
  normalize(frames) {
    const ctx = new AdapterContext(frames);
    const normalizer = new AnthropicStreamNormalizer(ctx, directOptions);
    for (const frame of frames) {
      normalizer.processFrame(frame);
    }
    normalizer.finish();
    return ctx.result();
  }
};

export class AnthropicStreamNormalizer {
  private readonly blocks = new Map<number, ContentBlock>();
  private lastTextBlock: ContentBlock | undefined;
  private stopReason: string | undefined;
  private stopSequence: string | undefined;
  private usage: unknown;
  private terminalEmitted = false;
  private sawAnyProviderFrame = false;
  private readonly ctx: AdapterContext;
  private readonly options: AnthropicOptions;

  constructor(ctx: AdapterContext, options: AnthropicOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  processFrame(frame: InputFrame): void {
    if (frame.comment) {
      this.ctx.drop(frame, "sse_comment");
      return;
    }
    if (frame.done) {
      this.ctx.drop(frame, "done_sentinel");
      return;
    }
    if (frame.parseError || !isRecord(frame.data)) {
      this.ctx.diagnostic(frame, "parse_error", frame.parseError ?? frame.dataRaw);
      return;
    }
    this.sawAnyProviderFrame = true;
    this.processEvent(frame, frame.data);
  }

  processEvent(frame: InputFrame, event: Record<string, unknown>): void {
    const type = asString(event.type);
    switch (type) {
      case "message_start":
        this.onMessageStart(frame, event);
        return;
      case "content_block_start":
        this.onContentBlockStart(frame, event);
        return;
      case "content_block_delta":
        this.onContentBlockDelta(frame, event);
        return;
      case "content_block_stop":
        this.onContentBlockStop(frame, event);
        return;
      case "message_delta":
        this.onMessageDelta(frame, event);
        return;
      case "message_stop":
        this.onMessageStop(frame);
        return;
      case "ping":
        this.ctx.drop(frame, "ping");
        return;
      case "error":
        this.ctx.emit(frame, "lifecycle", {
          phase: "error",
          reason: "error",
          status: "incomplete",
          diagnostic: { code: "provider_error", detail: event }
        });
        this.terminalEmitted = true;
        return;
      default:
        this.ctx.diagnostic(frame, "unknown_frame", event);
    }
  }

  finish(): void {
    if (this.terminalEmitted || !this.options.synthesizeStreamClosed || !this.sawAnyProviderFrame) {
      return;
    }
    this.closeOpenThinking(undefined);
    this.ctx.observed.synthesizedStreamClosed = true;
    this.ctx.emit(undefined, "lifecycle", {
      phase: "error",
      reason: "stream_closed",
      status: "incomplete",
      diagnostic: { code: "stream_closed" }
    });
    this.terminalEmitted = true;
  }

  hasTerminal(): boolean {
    return this.terminalEmitted;
  }

  latestUsage(): unknown {
    return this.usage;
  }

  private onMessageStart(frame: InputFrame, event: Record<string, unknown>): void {
    if (!this.options.emitLifecycleStart) {
      this.ctx.drop(frame, "inner_message_start");
      return;
    }
    const message = isRecord(event.message) ? event.message : {};
    this.ctx.emit(frame, "lifecycle", {
      phase: "start",
      provider: "anthropic",
      model: asString(message.model),
      id: asString(message.id),
      usage: message.usage
    });
  }

  private onContentBlockStart(frame: InputFrame, event: Record<string, unknown>): void {
    const index = typeof event.index === "number" ? event.index : -1;
    const contentBlock = isRecord(event.content_block) ? event.content_block : {};
    const blockType = asString(contentBlock.type) ?? "unknown";
    const block: ContentBlock = {
      index,
      type: blockType,
      id: String(index),
      name: asString(contentBlock.name),
      text: asString(contentBlock.text) ?? asString(contentBlock.thinking) ?? "",
      inputJson: "",
      thinkingStarted: false,
      sawSignature: Boolean(asString(contentBlock.signature))
    };
    this.blocks.set(index, block);

    if (block.sawSignature) {
      this.ctx.recordTranscript(frame, "anthropic_signature", contentBlock.signature);
    }

    if (blockType === "tool_use" || blockType === "server_tool_use") {
      const id = asString(contentBlock.id) ?? block.id;
      block.id = id;
      this.ctx.emit(frame, "item", {
        phase: "start",
        id,
        index,
        kind: "tool",
        name: block.name,
        status: "in_progress",
        input: contentBlock.input
      });
      return;
    }

    if (blockType === "redacted_thinking") {
      this.ctx.emit(frame, "thinking", {
        id: block.id,
        variant: "redacted",
        phase: "start"
      });
      return;
    }

    if (blockType === "fallback") {
      this.ctx.emit(frame, "lifecycle", {
        phase: "update",
        diagnostic: { code: "model_fallback", detail: contentBlock }
      });
      return;
    }

    this.ctx.drop(frame, `content_block_start:${blockType}`);
  }

  private onContentBlockDelta(frame: InputFrame, event: Record<string, unknown>): void {
    const index = typeof event.index === "number" ? event.index : -1;
    const block = this.blocks.get(index);
    const delta = isRecord(event.delta) ? event.delta : {};
    const deltaType = asString(delta.type);

    if (!block) {
      this.ctx.diagnostic(frame, "delta_without_block", event);
      return;
    }

    switch (deltaType) {
      case "text_delta": {
        const text = asString(delta.text);
        if (!text) {
          this.ctx.drop(frame, "empty_text_delta");
          return;
        }
        block.text += text;
        this.lastTextBlock = block;
        this.ctx.emit(frame, "assistant", {
          id: block.id,
          phase: "commentary",
          delta: text,
          status: "in_progress"
        });
        return;
      }
      case "thinking_delta": {
        const thinking = asString(delta.thinking);
        if (!thinking) {
          this.ctx.drop(frame, "empty_thinking_delta");
          return;
        }
        if (!block.thinkingStarted) {
          block.thinkingStarted = true;
          this.ctx.emit(frame, "thinking", {
            id: block.id,
            variant: "raw",
            phase: "start"
          });
        }
        block.text += thinking;
        this.ctx.emit(frame, "thinking", {
          id: block.id,
          variant: "raw",
          delta: thinking
        });
        return;
      }
      case "signature_delta":
        block.sawSignature = true;
        this.ctx.recordTranscript(frame, "anthropic_signature_delta", delta.signature);
        return;
      case "input_json_delta": {
        const partial = asString(delta.partial_json) ?? "";
        block.inputJson += partial;
        if (partial === "") {
          this.ctx.drop(frame, "empty_input_json_delta");
          return;
        }
        this.ctx.emit(frame, "item", {
          phase: "update",
          id: block.id,
          index,
          kind: "tool",
          name: block.name,
          status: "in_progress",
          input_delta: partial
        });
        return;
      }
      case "citations_delta":
        this.ctx.recordTranscript(frame, "anthropic_citations_delta", delta);
        this.ctx.diagnostic(frame, "unsupported_frame", { type: "citations_delta" });
        return;
      default:
        this.ctx.diagnostic(frame, "unknown_delta", event);
    }
  }

  private onContentBlockStop(frame: InputFrame, event: Record<string, unknown>): void {
    const index = typeof event.index === "number" ? event.index : -1;
    const block = this.blocks.get(index);
    if (!block) {
      this.ctx.diagnostic(frame, "stop_without_block", event);
      return;
    }

    if (block.type === "thinking") {
      if (block.thinkingStarted) {
        block.thinkingEnd = this.ctx.emit(frame, "thinking", {
          id: block.id,
          variant: "raw",
          phase: "end"
        });
      } else {
        this.ctx.emit(frame, "thinking", {
          id: block.id,
          variant: "redacted",
          phase: "start"
        });
        block.thinkingEnd = this.ctx.emit(frame, "thinking", {
          id: block.id,
          variant: "redacted",
          phase: "end"
        });
      }
      return;
    }

    if (block.type === "redacted_thinking") {
      block.thinkingEnd = this.ctx.emit(frame, "thinking", {
        id: block.id,
        variant: "redacted",
        phase: "end"
      });
      return;
    }

    if (block.type === "tool_use" || block.type === "server_tool_use") {
      this.ctx.emit(frame, "item", {
        phase: "end",
        id: block.id,
        index,
        kind: "tool",
        name: block.name,
        status: "completed",
        arguments: parseMaybeJson(block.inputJson)
      });
      return;
    }

    this.ctx.drop(frame, `content_block_stop:${block.type}`);
  }

  private onMessageDelta(frame: InputFrame, event: Record<string, unknown>): void {
    const delta = isRecord(event.delta) ? event.delta : {};
    this.stopReason = asString(delta.stop_reason);
    this.stopSequence = asString(delta.stop_sequence);
    this.usage = event.usage;
    this.backfillThinkingTokens(event.usage);
    this.ctx.drop(frame, "message_delta_buffered");
  }

  private onMessageStop(frame: InputFrame): void {
    if (!this.options.emitTerminal) {
      this.ctx.drop(frame, "inner_message_stop");
      return;
    }
    this.dispatchTerminal(frame, this.stopReason);
  }

  private dispatchTerminal(frame: InputFrame, stopReason: string | undefined): void {
    this.closeOpenThinking(frame);
    const usage = this.usage;
    switch (stopReason) {
      case "end_turn":
        this.emitFinal(frame, false);
        this.ctx.emit(frame, "lifecycle", {
          phase: "end",
          reason: "completed",
          status: "completed",
          usage
        });
        break;
      case "stop_sequence":
        this.emitFinal(frame, false);
        this.ctx.emit(frame, "lifecycle", {
          phase: "end",
          reason: "stop_sequence",
          status: "completed",
          usage,
          diagnostic: { code: "stop_sequence", detail: this.stopSequence }
        });
        break;
      case "max_tokens":
        this.emitFinal(frame, true);
        this.ctx.emit(frame, "lifecycle", {
          phase: "end",
          reason: "truncated",
          status: "incomplete",
          usage
        });
        break;
      case "refusal":
        this.ctx.emit(frame, "lifecycle", {
          phase: "error",
          reason: "refusal",
          status: "incomplete",
          usage
        });
        break;
      case "pause_turn":
        this.ctx.emit(frame, "lifecycle", {
          phase: "end",
          reason: "paused",
          status: "incomplete",
          usage
        });
        break;
      case "tool_use":
      case "server_tool_use":
        this.ctx.emit(frame, "lifecycle", {
          phase: "end",
          reason: "tool_use",
          status: "completed",
          usage
        });
        break;
      default:
        this.ctx.emit(frame, "lifecycle", {
          phase: "error",
          reason: "error",
          status: "incomplete",
          usage,
          diagnostic: { code: "unknown_stop_reason", detail: stopReason }
        });
    }
    this.terminalEmitted = true;
  }

  private emitFinal(frame: InputFrame, truncated: boolean): void {
    if (!this.options.emitFinalAnswer) {
      return;
    }
    if (!this.lastTextBlock || this.lastTextBlock.text === "") {
      return;
    }
    this.ctx.emit(frame, "assistant", {
      id: this.lastTextBlock.id,
      phase: "final_answer",
      text: this.lastTextBlock.text,
      status: "completed",
      ...(truncated ? { truncated: true } : {})
    });
  }

  private closeOpenThinking(frame: InputFrame | undefined): void {
    for (const block of this.blocks.values()) {
      if ((block.type === "thinking" || block.type === "redacted_thinking") && block.thinkingStarted && !block.thinkingEnd) {
        block.thinkingEnd = this.ctx.emit(frame, "thinking", {
          id: block.id,
          variant: "raw",
          phase: "end"
        });
      }
    }
  }

  private backfillThinkingTokens(usage: unknown): void {
    if (!isRecord(usage)) return;
    const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
    const tokens = typeof details?.thinking_tokens === "number" ? details.thinking_tokens : undefined;
    if (tokens === undefined) return;
    for (const block of this.blocks.values()) {
      if (block.thinkingEnd) {
        block.thinkingEnd.data.tokens = tokens;
      }
    }
  }
}
