export type AdapterId = "f1" | "f1e" | "f2" | "f3" | "f5" | "ollama-native";

export type StreamName = "assistant" | "thinking" | "item" | "lifecycle";

export type AssistantEventData = {
  delta?: string;
  text?: string;
  phase?: "commentary" | "final_answer";
  id?: string;
  status?: "in_progress" | "completed";
  truncated?: boolean;
};

export type ThinkingEventData = {
  delta?: string;
  text?: string;
  id?: string;
  variant: "raw" | "summary" | "redacted";
  phase?: "start" | "end";
  tokens?: number;
};

export type ItemEventData = {
  phase: "start" | "update" | "end";
  id?: string;
  index?: number;
  kind: "tool";
  name?: string;
  status?: "in_progress" | "completed" | "failed";
  input_delta?: string;
  input?: unknown;
  arguments?: unknown;
};

export type LifecycleEventData = {
  phase: "start" | "update" | "end" | "error";
  reason?:
    | "completed"
    | "truncated"
    | "stop_sequence"
    | "tool_use"
    | "paused"
    | "refusal"
    | "content_filter"
    | "error"
    | "stream_closed"
    | "incomplete";
  status?: "completed" | "incomplete";
  provider?: string;
  model?: string;
  id?: string;
  usage?: unknown;
  diagnostic?: {
    code: string;
    message?: string;
    detail?: unknown;
  };
};

export type NormalizedEvent =
  | { seq: number; stream: "assistant"; data: AssistantEventData }
  | { seq: number; stream: "thinking"; data: ThinkingEventData }
  | { seq: number; stream: "item"; data: ItemEventData }
  | { seq: number; stream: "lifecycle"; data: LifecycleEventData };

export type InputFrame = {
  index: number;
  transport: "sse" | "jsonl";
  raw: string;
  event?: string;
  dataRaw?: string;
  data?: unknown;
  done?: boolean;
  comment?: string;
  parseError?: string;
};

export type DispositionKind =
  | "event"
  | "transcript"
  | "documented-drop"
  | "diagnostic";

export type FrameDisposition = {
  frameIndex: number;
  kind: DispositionKind;
  detail: string;
};

export type TranscriptEntry = {
  frameIndex: number;
  kind: string;
  material: unknown;
};

export type AdapterObservation = {
  usageLocations?: Array<"top-level" | "choice" | "delta">;
  sawDone?: boolean;
  synthesizedStreamClosed?: boolean;
};

export type AdapterRunResult = {
  events: NormalizedEvent[];
  eventSources: number[];
  transcript: TranscriptEntry[];
  dispositions: FrameDisposition[];
  observed: AdapterObservation;
};

export type ReplayResult = AdapterRunResult & {
  adapter: AdapterId;
  capturePath: string;
  frames: InputFrame[];
};

export type Adapter = {
  id: AdapterId;
  normalize(frames: InputFrame[], capturePath: string): AdapterRunResult;
};
