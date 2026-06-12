import type {
  AdapterObservation,
  AdapterRunResult,
  DispositionKind,
  FrameDisposition,
  InputFrame,
  NormalizedEvent,
  StreamName,
  TranscriptEntry
} from "./types.ts";

type EventForStream<S extends StreamName> = Extract<NormalizedEvent, { stream: S }>;

export class AdapterContext {
  private seq = 0;
  readonly events: NormalizedEvent[] = [];
  readonly eventSources: number[] = [];
  readonly transcript: TranscriptEntry[] = [];
  readonly dispositions: FrameDisposition[] = [];
  readonly observed: AdapterObservation = {};
  readonly frames: InputFrame[];

  constructor(frames: InputFrame[]) {
    this.frames = frames;
  }

  emit<S extends StreamName>(
    frame: InputFrame | undefined,
    stream: S,
    data: EventForStream<S>["data"]
  ): EventForStream<S> {
    const event = { seq: ++this.seq, stream, data } as EventForStream<S>;
    this.events.push(event);
    this.eventSources.push(frame?.index ?? Number.MAX_SAFE_INTEGER);
    if (frame) {
      this.mark(frame, "event", stream);
    }
    return event;
  }

  mark(frame: InputFrame, kind: DispositionKind, detail: string): void {
    this.dispositions.push({ frameIndex: frame.index, kind, detail });
  }

  drop(frame: InputFrame, detail: string): void {
    this.mark(frame, "documented-drop", detail);
  }

  recordTranscript(frame: InputFrame, kind: string, material: unknown): void {
    this.transcript.push({ frameIndex: frame.index, kind, material });
    this.mark(frame, "transcript", kind);
  }

  diagnostic(frame: InputFrame, code: string, detail?: unknown): void {
    this.mark(frame, "diagnostic", code);
    this.emit(frame, "lifecycle", {
      phase: "update",
      diagnostic: { code, detail }
    });
  }

  usage(location: "top-level" | "choice" | "delta"): void {
    this.observed.usageLocations ??= [];
    if (!this.observed.usageLocations.includes(location)) {
      this.observed.usageLocations.push(location);
    }
  }

  result(): AdapterRunResult {
    return {
      events: this.events,
      eventSources: this.eventSources,
      transcript: this.transcript,
      dispositions: this.dispositions,
      observed: this.observed
    };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseMaybeJson(text: string): unknown {
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
