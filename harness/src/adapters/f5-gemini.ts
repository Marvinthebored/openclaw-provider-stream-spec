import { AdapterContext, asString, isRecord } from "../adapter-context.ts";
import type { Adapter, InputFrame, NormalizedEvent } from "../types.ts";

type ToolState = {
  id?: string;
  index: number;
  name?: string;
  args?: unknown;
  ended: boolean;
};

type TerminalPath = {
  phase: "end" | "error";
  reason: "completed" | "truncated" | "tool_use" | "content_filter" | "error" | "stream_closed" | "incomplete";
  status: "completed" | "incomplete";
  emitFinal: boolean;
  truncated?: boolean;
  diagnostic?: { code: string; detail?: unknown };
};

export const f5GeminiAdapter: Adapter = {
  id: "f5",
  normalize(frames) {
    const normalizer = new F5GeminiNormalizer(frames);
    return normalizer.run();
  }
};

class F5GeminiNormalizer {
  private readonly ctx: AdapterContext;
  private readonly frames: InputFrame[];
  private usage: unknown;
  private responseId: string | undefined;
  private model: string | undefined;
  private started = false;
  private sawProviderFrame = false;
  private terminalEmitted = false;
  private terminalPath: TerminalPath | undefined;
  private text = "";
  private thinkingOpen = false;
  private thinkingEnd: Extract<NormalizedEvent, { stream: "thinking" }> | undefined;
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
    if (this.terminalEmitted) {
      this.ctx.drop(frame, "post_terminal_frame");
      return;
    }
    this.sawProviderFrame = true;
    this.processChunk(frame, frame.data);
  }

  private processChunk(frame: InputFrame, chunk: Record<string, unknown>): void {
    this.responseId = asString(chunk.responseId) ?? this.responseId;
    this.model = asString(chunk.modelVersion) ?? this.model;
    if (isRecord(chunk.usageMetadata)) {
      this.usage = chunk.usageMetadata;
      this.ctx.mark(frame, "documented-drop", "usage_captured");
    }
    this.emitStart(frame);

    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
    if (candidates.length === 0) {
      this.ctx.diagnostic(frame, "missing_candidates", chunk);
      return;
    }

    for (const candidate of candidates) {
      if (!isRecord(candidate)) {
        this.ctx.diagnostic(frame, "malformed_candidate", candidate);
        continue;
      }
      this.processCandidate(frame, candidate);
    }
  }

  private emitStart(frame: InputFrame): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.ctx.emit(frame, "lifecycle", {
      phase: "start",
      provider: "gemini",
      model: this.model,
      id: this.responseId
    });
  }

  private processCandidate(frame: InputFrame, candidate: Record<string, unknown>): void {
    const content = isRecord(candidate.content) ? candidate.content : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    let sawFunctionCall = false;

    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      if (!isRecord(part)) {
        this.ctx.diagnostic(frame, "malformed_part", part);
        continue;
      }
      if ("thoughtSignature" in part) {
        this.ctx.recordTranscript(frame, "gemini_thought_signature", part.thoughtSignature);
      }
      const functionCall = isRecord(part.functionCall) ? part.functionCall : undefined;
      if (functionCall) {
        this.closeThinking(frame);
        sawFunctionCall = true;
        this.startTool(frame, candidate, partIndex, functionCall);
        continue;
      }
      const text = asString(part.text);
      if (text) {
        if (part.thought === true) {
          this.emitThinking(frame, text);
        } else {
          this.closeThinking(frame);
          this.text += text;
          this.ctx.emit(frame, "assistant", {
            phase: "commentary",
            delta: text,
            status: "in_progress"
          });
        }
        continue;
      }
      this.ctx.diagnostic(frame, "unknown_part", part);
    }

    this.captureCandidateMetadata(frame, candidate);
    const finishReason = asString(candidate.finishReason);
    if (finishReason) {
      this.dispatchFinish(frame, finishReason, candidate, sawFunctionCall);
    }
  }

  private captureCandidateMetadata(frame: InputFrame, candidate: Record<string, unknown>): void {
    if (candidate.safetyRatings !== undefined) {
      this.ctx.recordTranscript(frame, "gemini_safety_ratings", candidate.safetyRatings);
    }
    if (candidate.citationMetadata !== undefined) {
      this.ctx.recordTranscript(frame, "gemini_citation_metadata", candidate.citationMetadata);
    }
  }

  private emitThinking(frame: InputFrame, text: string): void {
    if (!this.thinkingOpen) {
      this.thinkingOpen = true;
      this.ctx.emit(frame, "thinking", {
        variant: "summary",
        phase: "start"
      });
    }
    this.ctx.emit(frame, "thinking", {
      variant: "summary",
      delta: text
    });
  }

  private closeThinking(frame: InputFrame | undefined): void {
    if (!this.thinkingOpen || this.thinkingEnd) {
      return;
    }
    this.thinkingEnd = this.ctx.emit(frame, "thinking", {
      variant: "summary",
      phase: "end"
    });
    this.backfillThinkingTokens();
  }

  private startTool(
    frame: InputFrame,
    candidate: Record<string, unknown>,
    partIndex: number,
    functionCall: Record<string, unknown>
  ): void {
    const candidateIndex = typeof candidate.index === "number" ? candidate.index : 0;
    const tool: ToolState = {
      id: this.responseId ? `${this.responseId}:${candidateIndex}:${partIndex}` : undefined,
      index: candidateIndex,
      name: asString(functionCall.name),
      args: functionCall.args,
      ended: false
    };
    this.tools.push(tool);
    this.ctx.emit(frame, "item", {
      phase: "start",
      id: tool.id,
      index: tool.index,
      kind: "tool",
      name: tool.name,
      status: "in_progress",
      input: tool.args
    });
  }

  private dispatchFinish(
    frame: InputFrame,
    finishReason: string,
    candidate: Record<string, unknown>,
    sawFunctionCall: boolean
  ): void {
    const diagnostic = finishDiagnostic(candidate);
    switch (finishReason) {
      case "STOP":
        if (sawFunctionCall || this.tools.some((tool) => !tool.ended)) {
          this.terminalPath = {
            phase: "end",
            reason: "tool_use",
            status: "completed",
            emitFinal: false,
            diagnostic
          };
        } else {
          this.terminalPath = {
            phase: "end",
            reason: "completed",
            status: "completed",
            emitFinal: true,
            diagnostic
          };
        }
        break;
      case "MAX_TOKENS":
        this.terminalPath = {
          phase: "end",
          reason: "truncated",
          status: "incomplete",
          emitFinal: true,
          truncated: true,
          diagnostic
        };
        break;
      case "SAFETY":
      case "RECITATION":
        this.terminalPath = {
          phase: "error",
          reason: "content_filter",
          status: "incomplete",
          emitFinal: false,
          diagnostic: diagnostic ?? { code: "finish_reason", detail: finishReason }
        };
        break;
      case "OTHER":
        this.terminalPath = {
          phase: "end",
          reason: "incomplete",
          status: "incomplete",
          emitFinal: false,
          diagnostic: diagnostic ?? { code: "finish_reason", detail: finishReason }
        };
        break;
      case "MALFORMED_FUNCTION_CALL":
        this.endOpenTools(frame, "failed");
        this.terminalPath = {
          phase: "error",
          reason: "error",
          status: "incomplete",
          emitFinal: false,
          diagnostic: diagnostic ?? { code: "finish_reason", detail: finishReason }
        };
        break;
      default:
        this.terminalPath = {
          phase: "end",
          reason: "incomplete",
          status: "incomplete",
          emitFinal: false,
          diagnostic: { code: "unknown_finish_reason", detail: finishReason }
        };
    }
    this.emitTerminal(frame);
  }

  private emitTerminal(frame: InputFrame): void {
    if (!this.terminalPath || this.terminalEmitted) {
      return;
    }
    this.closeThinking(frame);
    this.endOpenTools(frame, this.terminalPath.reason === "error" ? "failed" : "completed");
    if (this.terminalPath.emitFinal && this.text !== "") {
      this.ctx.emit(frame, "assistant", {
        phase: "final_answer",
        text: this.text,
        status: "completed",
        ...(this.terminalPath.truncated ? { truncated: true } : {})
      });
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

  private endOpenTools(frame: InputFrame | undefined, status: "completed" | "failed"): void {
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
        arguments: tool.args
      });
    }
  }

  private backfillThinkingTokens(): void {
    if (!this.thinkingEnd || !isRecord(this.usage)) {
      return;
    }
    const tokens = typeof this.usage.thoughtsTokenCount === "number" ? this.usage.thoughtsTokenCount : undefined;
    if (tokens !== undefined) {
      this.thinkingEnd.data.tokens = tokens;
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

function finishDiagnostic(candidate: Record<string, unknown>): { code: string; detail?: unknown } | undefined {
  const finishMessage = asString(candidate.finishMessage);
  if (finishMessage) {
    return { code: "finish_message", detail: finishMessage };
  }
  if (candidate.safetyRatings !== undefined) {
    return { code: "safety_ratings", detail: candidate.safetyRatings };
  }
  if (candidate.citationMetadata !== undefined) {
    return { code: "citation_metadata", detail: candidate.citationMetadata };
  }
  return undefined;
}
