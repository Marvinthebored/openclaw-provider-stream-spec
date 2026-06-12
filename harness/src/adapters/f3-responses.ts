import {
  AdapterContext,
  asNumber,
  asString,
  isRecord,
  parseMaybeJson
} from "../adapter-context.ts";
import type { Adapter, InputFrame, NormalizedEvent } from "../types.ts";

type TextSegment = {
  id: string;
  itemId: string;
  contentIndex: number;
  outputIndex: number;
  itemType: "message" | "reasoning";
  partType: "output_text" | "refusal" | "reasoning_text";
  text: string;
  thinkingVariant?: "raw";
  thinkingStarted?: boolean;
  thinkingEnd?: Extract<NormalizedEvent, { stream: "thinking" }>;
};

type SummarySegment = {
  id: string;
  itemId: string;
  summaryIndex: number;
  outputIndex: number;
  text: string;
  thinkingStarted: boolean;
  thinkingEnd?: Extract<NormalizedEvent, { stream: "thinking" }>;
};

type OutputItem = {
  id: string;
  outputIndex: number;
  type: string;
  role?: string;
  done?: boolean;
  hasDisplayableThinking?: boolean;
  hasEncryptedThinking?: boolean;
};

type ToolState = {
  id: string;
  itemId: string;
  outputIndex: number;
  name?: string;
  argumentsText: string;
  ended: boolean;
};

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
  truncated?: boolean;
  emitFinal?: boolean;
  diagnostic?: { code: string; detail?: unknown };
};

export const f3ResponsesAdapter: Adapter = {
  id: "f3",
  normalize(frames) {
    const normalizer = new F3ResponsesNormalizer(frames);
    return normalizer.run();
  }
};

class F3ResponsesNormalizer {
  private readonly ctx: AdapterContext;
  private readonly frames: InputFrame[];
  private readonly itemsById = new Map<string, OutputItem>();
  private readonly itemsByOutputIndex = new Map<number, OutputItem>();
  private readonly textSegments = new Map<string, TextSegment>();
  private readonly summarySegments = new Map<string, SummarySegment>();
  private readonly tools = new Map<string, ToolState>();
  private usage: unknown;
  private responseId: string | undefined;
  private model: string | undefined;
  private terminalPath: TerminalPath | undefined;
  private terminalEmitted = false;
  private sawProviderFrame = false;
  private startEmitted = false;

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
    this.sawProviderFrame = true;
    this.processEvent(frame, frame.data);
  }

  private processEvent(frame: InputFrame, event: Record<string, unknown>): void {
    const type = asString(event.type) ?? frame.event;

    if (this.terminalEmitted) {
      if (type === "response.failed") {
        this.ctx.drop(frame, "post_error_response_failed");
      } else {
        this.ctx.drop(frame, "post_terminal_frame");
      }
      return;
    }

    switch (type) {
      case "response.created":
        this.onResponseCreated(frame, event);
        return;
      case "response.in_progress":
        this.captureResponseMetadata(event);
        this.ctx.drop(frame, "response_in_progress");
        return;
      case "response.queued":
        this.captureResponseMetadata(event);
        this.ctx.emit(frame, "lifecycle", {
          phase: "update",
          diagnostic: { code: "response_queued" }
        });
        return;
      case "response.output_item.added":
        this.onOutputItemAdded(frame, event);
        return;
      case "response.output_item.done":
        this.onOutputItemDone(frame, event);
        return;
      case "response.content_part.added":
        this.onContentPart(frame, event, "added");
        return;
      case "response.content_part.done":
        this.onContentPart(frame, event, "done");
        return;
      case "response.output_text.delta":
        this.onOutputTextDelta(frame, event);
        return;
      case "response.output_text.done":
        this.onOutputTextDone(frame, event);
        return;
      case "response.refusal.delta":
        this.onRefusalDelta(frame, event);
        return;
      case "response.refusal.done":
        this.onRefusalDone(frame, event);
        return;
      case "response.reasoning_text.delta":
        this.onReasoningTextDelta(frame, event);
        return;
      case "response.reasoning_text.done":
        this.onReasoningTextDone(frame, event);
        return;
      case "response.reasoning_summary_part.added":
      case "response.reasoning_summary_part.done":
        this.onReasoningSummaryPart(frame, event);
        return;
      case "response.reasoning_summary_text.delta":
        this.onReasoningSummaryTextDelta(frame, event);
        return;
      case "response.reasoning_summary_text.done":
        this.onReasoningSummaryTextDone(frame, event);
        return;
      case "response.function_call_arguments.delta":
        this.onFunctionCallArgumentsDelta(frame, event);
        return;
      case "response.function_call_arguments.done":
        this.onFunctionCallArgumentsDone(frame, event);
        return;
      case "response.output_text.annotation.added":
        this.ctx.recordTranscript(frame, "openai_output_text_annotation", event.annotation);
        this.ctx.emit(frame, "lifecycle", {
          phase: "update",
          diagnostic: { code: "output_text_annotation", detail: event.annotation }
        });
        return;
      case "response.completed":
        this.onResponseCompleted(frame, event);
        return;
      case "response.incomplete":
        this.onResponseIncomplete(frame, event);
        return;
      case "response.failed":
        this.onResponseFailed(frame, event);
        return;
      case "error":
        this.onStreamError(frame, event);
        return;
      default:
        this.ctx.diagnostic(frame, "unknown_frame", event);
    }
  }

  private onResponseCreated(frame: InputFrame, event: Record<string, unknown>): void {
    const response = isRecord(event.response) ? event.response : {};
    this.captureResponse(response);
    if (this.startEmitted) {
      this.ctx.drop(frame, "duplicate_response_created");
      return;
    }
    this.startEmitted = true;
    this.ctx.emit(frame, "lifecycle", {
      phase: "start",
      provider: "openai",
      model: this.model,
      id: this.responseId,
      usage: response.usage
    });
  }

  private onOutputItemAdded(frame: InputFrame, event: Record<string, unknown>): void {
    const item = isRecord(event.item) ? event.item : {};
    const type = asString(item.type) ?? "unknown";
    const outputIndex = asNumber(event.output_index) ?? -1;
    const itemId = asString(item.id) ?? `${outputIndex}`;
    const outputItem: OutputItem = {
      id: itemId,
      outputIndex,
      type,
      role: asString(item.role),
      hasDisplayableThinking: false,
      hasEncryptedThinking: "encrypted_content" in item
    };
    this.itemsById.set(itemId, outputItem);
    this.itemsByOutputIndex.set(outputIndex, outputItem);

    if (type === "function_call") {
      this.startTool(frame, item, outputIndex, itemId);
      return;
    }

    if (type === "reasoning" && "encrypted_content" in item) {
      this.recordEncryptedReasoning(frame, outputItem, item.encrypted_content);
      return;
    }

    this.ctx.drop(frame, `output_item_added:${type}`);
  }

  private onOutputItemDone(frame: InputFrame, event: Record<string, unknown>): void {
    const item = isRecord(event.item) ? event.item : {};
    const type = asString(item.type) ?? "unknown";
    const outputIndex = asNumber(event.output_index) ?? -1;
    const itemId = asString(item.id) ?? `${outputIndex}`;
    const outputItem = this.ensureOutputItem(itemId, outputIndex, type, asString(item.role));
    outputItem.done = true;

    if (type === "message") {
      this.captureMessageSnapshot(item, outputIndex, itemId);
      this.ctx.drop(frame, "output_item_done:message");
      return;
    }

    if (type === "reasoning") {
      if ("encrypted_content" in item) {
        this.recordEncryptedReasoning(frame, outputItem, item.encrypted_content);
      }
      if (outputItem.hasEncryptedThinking && !outputItem.hasDisplayableThinking) {
        this.emitRedactedThinking(frame, outputItem);
        return;
      }
      this.ctx.drop(frame, "output_item_done:reasoning");
      return;
    }

    if (type === "function_call") {
      this.finishToolFromSnapshot(frame, item, outputIndex, itemId);
      return;
    }

    this.ctx.diagnostic(frame, "unsupported_output_item", item);
  }

  private onContentPart(frame: InputFrame, event: Record<string, unknown>, phase: "added" | "done"): void {
    const part = isRecord(event.part) ? event.part : {};
    const partType = asString(part.type) ?? "unknown";
    const itemId = asString(event.item_id) ?? "";
    const outputIndex = asNumber(event.output_index) ?? -1;
    const contentIndex = asNumber(event.content_index) ?? 0;

    if (partType === "output_text" || partType === "refusal" || partType === "reasoning_text") {
      const itemType = partType === "reasoning_text" ? "reasoning" : "message";
      const segment = this.ensureTextSegment(itemId, outputIndex, contentIndex, itemType, partType);
      const text = asString(part.text) ?? asString(part.refusal);
      if (text) {
        segment.text = text;
      }
      if (phase === "done" && partType === "reasoning_text") {
        this.closeThinking(segment, frame);
      }
      this.ctx.drop(frame, `content_part_${phase}:${partType}`);
      return;
    }

    this.ctx.diagnostic(frame, "unsupported_content_part", part);
  }

  private onOutputTextDelta(frame: InputFrame, event: Record<string, unknown>): void {
    const delta = asString(event.delta);
    if (!delta) {
      this.ctx.drop(frame, "empty_output_text_delta");
      return;
    }
    const segment = this.segmentFromEvent(event, "message", "output_text");
    segment.text += delta;
    this.ctx.emit(frame, "assistant", {
      id: segment.id,
      phase: "commentary",
      delta,
      status: "in_progress"
    });
  }

  private onOutputTextDone(frame: InputFrame, event: Record<string, unknown>): void {
    const segment = this.segmentFromEvent(event, "message", "output_text");
    const text = asString(event.text);
    if (text) {
      segment.text = text;
    }
    this.ctx.drop(frame, "output_text_done");
  }

  private onRefusalDelta(frame: InputFrame, event: Record<string, unknown>): void {
    const delta = asString(event.delta);
    if (!delta) {
      this.ctx.drop(frame, "empty_refusal_delta");
      return;
    }
    const segment = this.segmentFromEvent(event, "message", "refusal");
    segment.text += delta;
    this.ctx.emit(frame, "assistant", {
      id: segment.id,
      phase: "commentary",
      delta,
      status: "in_progress"
    });
  }

  private onRefusalDone(frame: InputFrame, event: Record<string, unknown>): void {
    const segment = this.segmentFromEvent(event, "message", "refusal");
    const text = asString(event.refusal);
    if (text) {
      segment.text = text;
    }
    this.ctx.drop(frame, "refusal_done");
  }

  private onReasoningTextDelta(frame: InputFrame, event: Record<string, unknown>): void {
    const delta = asString(event.delta);
    if (!delta) {
      this.ctx.drop(frame, "empty_reasoning_text_delta");
      return;
    }
    const segment = this.segmentFromEvent(event, "reasoning", "reasoning_text");
    segment.thinkingVariant = "raw";
    this.markReasoningDisplayable(segment.itemId);
    if (!segment.thinkingStarted) {
      segment.thinkingStarted = true;
      this.ctx.emit(frame, "thinking", {
        id: segment.id,
        variant: "raw",
        phase: "start"
      });
    }
    segment.text += delta;
    this.ctx.emit(frame, "thinking", {
      id: segment.id,
      variant: "raw",
      delta
    });
  }

  private onReasoningTextDone(frame: InputFrame, event: Record<string, unknown>): void {
    const segment = this.segmentFromEvent(event, "reasoning", "reasoning_text");
    const text = asString(event.text);
    if (text) {
      segment.text = text;
    }
    this.closeThinking(segment, frame);
  }

  private onReasoningSummaryPart(frame: InputFrame, event: Record<string, unknown>): void {
    const itemId = asString(event.item_id) ?? "";
    const outputIndex = asNumber(event.output_index) ?? -1;
    const summaryIndex = asNumber(event.summary_index) ?? 0;
    const segment = this.ensureSummarySegment(itemId, outputIndex, summaryIndex);
    const part = isRecord(event.part) ? event.part : {};
    const text = asString(part.text);
    if (text) {
      segment.text = text;
    }
    this.ctx.drop(frame, `reasoning_summary_part:${asString(event.type) ?? "unknown"}`);
  }

  private onReasoningSummaryTextDelta(frame: InputFrame, event: Record<string, unknown>): void {
    const delta = asString(event.delta);
    if (!delta) {
      this.ctx.drop(frame, "empty_reasoning_summary_delta");
      return;
    }
    const segment = this.summarySegmentFromEvent(event);
    this.markReasoningDisplayable(segment.itemId);
    if (!segment.thinkingStarted) {
      segment.thinkingStarted = true;
      this.ctx.emit(frame, "thinking", {
        id: segment.id,
        variant: "summary",
        phase: "start"
      });
    }
    segment.text += delta;
    this.ctx.emit(frame, "thinking", {
      id: segment.id,
      variant: "summary",
      delta
    });
  }

  private onReasoningSummaryTextDone(frame: InputFrame, event: Record<string, unknown>): void {
    const segment = this.summarySegmentFromEvent(event);
    const text = asString(event.text);
    if (text) {
      segment.text = text;
    }
    if (segment.thinkingStarted && !segment.thinkingEnd) {
      segment.thinkingEnd = this.ctx.emit(frame, "thinking", {
        id: segment.id,
        variant: "summary",
        phase: "end"
      });
      this.backfillThinkingTokens();
      return;
    }
    this.ctx.drop(frame, "reasoning_summary_text_done");
  }

  private onFunctionCallArgumentsDelta(frame: InputFrame, event: Record<string, unknown>): void {
    const delta = asString(event.delta);
    if (!delta) {
      this.ctx.drop(frame, "empty_function_call_arguments_delta");
      return;
    }
    const itemId = asString(event.item_id) ?? "";
    const outputIndex = asNumber(event.output_index) ?? -1;
    const tool = this.ensureTool(itemId, outputIndex);
    tool.argumentsText += delta;
    this.ctx.emit(frame, "item", {
      phase: "update",
      id: tool.id,
      index: outputIndex,
      kind: "tool",
      name: tool.name,
      status: "in_progress",
      input_delta: delta
    });
  }

  private onFunctionCallArgumentsDone(frame: InputFrame, event: Record<string, unknown>): void {
    const itemId = asString(event.item_id) ?? "";
    const outputIndex = asNumber(event.output_index) ?? -1;
    const tool = this.ensureTool(itemId, outputIndex);
    const args = asString(event.arguments);
    if (args !== undefined) {
      tool.argumentsText = args;
    }
    this.endTool(frame, tool, "completed");
  }

  private onResponseCompleted(frame: InputFrame, event: Record<string, unknown>): void {
    const response = isRecord(event.response) ? event.response : {};
    this.captureResponse(response);
    this.captureCompletedOutput(frame, response.output);
    this.usage = response.usage;
    this.backfillThinkingTokens();

    const toolYield = this.isToolYield(response.output);
    this.terminalPath = toolYield
      ? { phase: "end", reason: "tool_use", status: "completed", emitFinal: false }
      : { phase: "end", reason: "completed", status: "completed", emitFinal: true };
    this.emitTerminal(frame);
  }

  private onResponseIncomplete(frame: InputFrame, event: Record<string, unknown>): void {
    const response = isRecord(event.response) ? event.response : {};
    this.captureResponse(response);
    this.captureCompletedOutput(frame, response.output);
    this.usage = response.usage;
    this.backfillThinkingTokens();

    const reason = incompleteReason(response);
    if (isTokenLimitReason(reason)) {
      this.terminalPath = {
        phase: "end",
        reason: "truncated",
        status: "incomplete",
        truncated: true,
        emitFinal: true,
        diagnostic: { code: "incomplete_reason", detail: reason }
      };
    } else if (isContentFilterReason(reason)) {
      this.terminalPath = {
        phase: "error",
        reason: "content_filter",
        status: "incomplete",
        emitFinal: false,
        diagnostic: { code: "incomplete_reason", detail: reason }
      };
    } else {
      this.terminalPath = {
        phase: "end",
        reason: "incomplete",
        status: "incomplete",
        emitFinal: false,
        diagnostic: { code: "unknown_incomplete_reason", detail: reason }
      };
    }
    this.emitTerminal(frame);
  }

  private onResponseFailed(frame: InputFrame, event: Record<string, unknown>): void {
    const response = isRecord(event.response) ? event.response : {};
    this.captureResponse(response);
    this.terminalPath = {
      phase: "error",
      reason: "error",
      status: "incomplete",
      diagnostic: { code: "response_failed", detail: response.error ?? event }
    };
    this.emitTerminal(frame);
  }

  private onStreamError(frame: InputFrame, event: Record<string, unknown>): void {
    const error = isRecord(event.error) ? event.error : event;
    this.terminalPath = {
      phase: "error",
      reason: "error",
      status: "incomplete",
      diagnostic: { code: asString(error.code) ?? "provider_error", message: asString(error.message), detail: error }
    };
    this.emitTerminal(frame);
  }

  private captureResponseMetadata(event: Record<string, unknown>): void {
    const response = isRecord(event.response) ? event.response : undefined;
    if (response) {
      this.captureResponse(response);
    }
  }

  private captureResponse(response: Record<string, unknown>): void {
    this.responseId = asString(response.id) ?? this.responseId;
    this.model = asString(response.model) ?? this.model;
    if (response.usage !== undefined && response.usage !== null) {
      this.usage = response.usage;
    }
  }

  private captureMessageSnapshot(item: Record<string, unknown>, outputIndex: number, itemId: string): void {
    const content = Array.isArray(item.content) ? item.content : [];
    for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
      const part = content[contentIndex];
      if (!isRecord(part)) continue;
      const partType = asString(part.type);
      if (partType !== "output_text" && partType !== "refusal") continue;
      const segment = this.ensureTextSegment(itemId, outputIndex, contentIndex, "message", partType);
      const text = asString(part.text) ?? asString(part.refusal);
      if (text) {
        segment.text = text;
      }
    }
  }

  private captureCompletedOutput(frame: InputFrame, output: unknown): void {
    if (!Array.isArray(output)) {
      return;
    }
    for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
      const item = output[outputIndex];
      if (!isRecord(item)) continue;
      const itemId = asString(item.id) ?? `${outputIndex}`;
      const type = asString(item.type) ?? "unknown";
      const outputItem = this.ensureOutputItem(itemId, outputIndex, type, asString(item.role));
      outputItem.done = true;
      if (type === "message") {
        this.captureMessageSnapshot(item, outputIndex, itemId);
      } else if (type === "reasoning" && "encrypted_content" in item) {
        outputItem.hasEncryptedThinking = true;
      } else if (type === "function_call") {
        this.finishToolFromSnapshot(frame, item, outputIndex, itemId);
      }
    }
  }

  private startTool(frame: InputFrame, item: Record<string, unknown>, outputIndex: number, itemId: string): ToolState {
    const id = asString(item.call_id) ?? itemId;
    const tool: ToolState = {
      id,
      itemId,
      outputIndex,
      name: asString(item.name),
      argumentsText: asString(item.arguments) ?? "",
      ended: false
    };
    this.tools.set(itemId, tool);
    this.ctx.emit(frame, "item", {
      phase: "start",
      id,
      index: outputIndex,
      kind: "tool",
      name: tool.name,
      status: "in_progress",
      input: tool.argumentsText ? parseMaybeJson(tool.argumentsText) : undefined
    });
    return tool;
  }

  private ensureTool(itemId: string, outputIndex: number): ToolState {
    let tool = this.tools.get(itemId);
    if (!tool) {
      const item = this.itemsById.get(itemId);
      tool = {
        id: itemId,
        itemId,
        outputIndex: item?.outputIndex ?? outputIndex,
        argumentsText: "",
        ended: false
      };
      this.tools.set(itemId, tool);
      this.ctx.emit(undefined, "item", {
        phase: "start",
        id: tool.id,
        index: tool.outputIndex,
        kind: "tool",
        status: "in_progress"
      });
    }
    return tool;
  }

  private finishToolFromSnapshot(
    frame: InputFrame | undefined,
    item: Record<string, unknown>,
    outputIndex: number,
    itemId: string
  ): void {
    let tool = this.tools.get(itemId);
    if (!tool) {
      tool = this.startTool(frame ?? this.frames[this.frames.length - 1], item, outputIndex, itemId);
    }
    tool.name = asString(item.name) ?? tool.name;
    const args = asString(item.arguments);
    if (args !== undefined) {
      tool.argumentsText = args;
    }
    this.endTool(frame, tool, asString(item.status) === "failed" ? "failed" : "completed");
  }

  private endTool(frame: InputFrame | undefined, tool: ToolState, status: "completed" | "failed"): void {
    if (tool.ended) {
      if (frame) {
        this.ctx.drop(frame, "duplicate_function_call_done");
      }
      return;
    }
    tool.ended = true;
    this.ctx.emit(frame, "item", {
      phase: "end",
      id: tool.id,
      index: tool.outputIndex,
      kind: "tool",
      name: tool.name,
      status,
      arguments: parseMaybeJson(tool.argumentsText)
    });
  }

  private ensureOutputItem(itemId: string, outputIndex: number, type: string, role?: string): OutputItem {
    let item = this.itemsById.get(itemId);
    if (!item) {
      item = {
        id: itemId,
        outputIndex,
        type,
        role,
        hasDisplayableThinking: false,
        hasEncryptedThinking: false
      };
      this.itemsById.set(itemId, item);
      this.itemsByOutputIndex.set(outputIndex, item);
    } else {
      item.type = type;
      item.role = role ?? item.role;
      this.itemsByOutputIndex.set(outputIndex, item);
    }
    return item;
  }

  private ensureTextSegment(
    itemId: string,
    outputIndex: number,
    contentIndex: number,
    itemType: "message" | "reasoning",
    partType: "output_text" | "refusal" | "reasoning_text"
  ): TextSegment {
    const id = `${itemId}:${contentIndex}`;
    let segment = this.textSegments.get(id);
    if (!segment) {
      segment = {
        id,
        itemId,
        contentIndex,
        outputIndex,
        itemType,
        partType,
        text: ""
      };
      this.textSegments.set(id, segment);
    }
    this.ensureOutputItem(itemId, outputIndex, itemType);
    return segment;
  }

  private ensureSummarySegment(itemId: string, outputIndex: number, summaryIndex: number): SummarySegment {
    const id = `${itemId}:${summaryIndex}`;
    let segment = this.summarySegments.get(id);
    if (!segment) {
      segment = {
        id,
        itemId,
        summaryIndex,
        outputIndex,
        text: "",
        thinkingStarted: false
      };
      this.summarySegments.set(id, segment);
    }
    this.ensureOutputItem(itemId, outputIndex, "reasoning");
    return segment;
  }

  private segmentFromEvent(
    event: Record<string, unknown>,
    itemType: "message" | "reasoning",
    partType: "output_text" | "refusal" | "reasoning_text"
  ): TextSegment {
    return this.ensureTextSegment(
      asString(event.item_id) ?? "",
      asNumber(event.output_index) ?? -1,
      asNumber(event.content_index) ?? 0,
      itemType,
      partType
    );
  }

  private summarySegmentFromEvent(event: Record<string, unknown>): SummarySegment {
    return this.ensureSummarySegment(
      asString(event.item_id) ?? "",
      asNumber(event.output_index) ?? -1,
      asNumber(event.summary_index) ?? 0
    );
  }

  private markReasoningDisplayable(itemId: string): void {
    const item = this.itemsById.get(itemId);
    if (item) {
      item.hasDisplayableThinking = true;
    }
  }

  private recordEncryptedReasoning(frame: InputFrame, item: OutputItem, encrypted: unknown): void {
    item.hasEncryptedThinking = true;
    this.ctx.recordTranscript(frame, "openai_reasoning_encrypted", encrypted);
  }

  private emitRedactedThinking(frame: InputFrame, item: OutputItem): void {
    this.ctx.emit(frame, "thinking", {
      id: item.id,
      variant: "redacted",
      phase: "start"
    });
    const end = this.ctx.emit(frame, "thinking", {
      id: item.id,
      variant: "redacted",
      phase: "end"
    });
    end.data.tokens = reasoningTokens(this.usage);
  }

  private closeThinking(segment: TextSegment, frame: InputFrame): void {
    if (!segment.thinkingStarted || segment.thinkingEnd) {
      this.ctx.drop(frame, "reasoning_text_done");
      return;
    }
    segment.thinkingEnd = this.ctx.emit(frame, "thinking", {
      id: segment.id,
      variant: "raw",
      phase: "end"
    });
    this.backfillThinkingTokens();
  }

  private finalSegment(): TextSegment | undefined {
    const messageItems = [...this.itemsById.values()]
      .filter((item) => item.type === "message" && (item.role === undefined || item.role === "assistant"))
      .sort((left, right) => left.outputIndex - right.outputIndex);
    const lastMessage = messageItems.at(-1);
    if (!lastMessage) {
      return undefined;
    }
    const segments = [...this.textSegments.values()]
      .filter((segment) => segment.itemId === lastMessage.id && segment.itemType === "message" && segment.text !== "")
      .sort((left, right) => left.contentIndex - right.contentIndex);
    return segments.at(-1);
  }

  private emitFinal(frame: InputFrame, truncated: boolean): void {
    const segment = this.finalSegment();
    if (!segment) {
      return;
    }
    this.ctx.emit(frame, "assistant", {
      id: segment.id,
      phase: "final_answer",
      text: segment.text,
      status: "completed",
      ...(truncated ? { truncated: true } : {})
    });
  }

  private isToolYield(output: unknown): boolean {
    const completedOutput = Array.isArray(output) ? output : undefined;
    const items = completedOutput
      ? completedOutput.filter(isRecord)
      : [...this.itemsById.values()];
    const last = items.at(-1);
    const lastType = last ? asString(last.type) : undefined;
    return lastType === "function_call" || lastType === "custom_tool_call";
  }

  private emitTerminal(frame: InputFrame): void {
    if (!this.terminalPath || this.terminalEmitted) {
      return;
    }
    this.closeOpenThinking(frame);
    this.endOpenTools(frame);
    if (this.terminalPath.emitFinal) {
      this.emitFinal(frame, Boolean(this.terminalPath.truncated));
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

  private closeOpenThinking(frame: InputFrame | undefined): void {
    for (const segment of this.textSegments.values()) {
      if (segment.partType === "reasoning_text" && segment.thinkingStarted && !segment.thinkingEnd) {
        segment.thinkingEnd = this.ctx.emit(frame, "thinking", {
          id: segment.id,
          variant: "raw",
          phase: "end"
        });
      }
    }
    for (const segment of this.summarySegments.values()) {
      if (segment.thinkingStarted && !segment.thinkingEnd) {
        segment.thinkingEnd = this.ctx.emit(frame, "thinking", {
          id: segment.id,
          variant: "summary",
          phase: "end"
        });
      }
    }
    this.backfillThinkingTokens();
  }

  private endOpenTools(frame: InputFrame | undefined): void {
    for (const tool of this.tools.values()) {
      if (!tool.ended) {
        this.endTool(frame, tool, "completed");
      }
    }
  }

  private backfillThinkingTokens(): void {
    const tokens = reasoningTokens(this.usage);
    if (tokens === undefined) {
      return;
    }
    for (const segment of this.textSegments.values()) {
      if (segment.thinkingEnd) {
        segment.thinkingEnd.data.tokens = tokens;
      }
    }
    for (const segment of this.summarySegments.values()) {
      if (segment.thinkingEnd) {
        segment.thinkingEnd.data.tokens = tokens;
      }
    }
  }

  private finish(): void {
    if (this.terminalEmitted) {
      return;
    }
    if (!this.sawProviderFrame) {
      return;
    }
    this.closeOpenThinking(undefined);
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

function incompleteReason(response: Record<string, unknown>): string | undefined {
  const details = isRecord(response.incomplete_details) ? response.incomplete_details : undefined;
  return asString(details?.reason);
}

function isTokenLimitReason(reason: string | undefined): boolean {
  return reason === "max_output_tokens" || reason === "max_tokens" || reason === "output_limit" || reason === "length";
}

function isContentFilterReason(reason: string | undefined): boolean {
  return reason === "content_filter" || reason === "safety" || reason === "content_policy";
}

function reasoningTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  return asNumber(details?.reasoning_tokens);
}
