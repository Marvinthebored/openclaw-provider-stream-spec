import { readFileSync } from "node:fs";
import type { Adapter, AdapterId, InputFrame, ReplayResult } from "./types.ts";
import { f1AnthropicSseAdapter } from "./adapters/f1-anthropic-sse.ts";
import { f1eClaudeCliAdapter } from "./adapters/f1e-claude-cli.ts";
import { f2ChatCompletionsAdapter } from "./adapters/f2-chat-completions.ts";
import { f3ResponsesAdapter } from "./adapters/f3-responses.ts";
import { f5GeminiAdapter } from "./adapters/f5-gemini.ts";
import { ollamaNativeAdapter } from "./adapters/ollama-native.ts";

const adapters: Record<AdapterId, Adapter> = {
  f1: f1AnthropicSseAdapter,
  f1e: f1eClaudeCliAdapter,
  f2: f2ChatCompletionsAdapter,
  f3: f3ResponsesAdapter,
  f5: f5GeminiAdapter,
  "ollama-native": ollamaNativeAdapter
};

export function replayCapture(capturePath: string, adapterId: AdapterId): ReplayResult {
  const frames = parseCapture(readFileSync(capturePath, "utf8"));
  const adapter = adapters[adapterId];
  const result = adapter.normalize(frames, capturePath);
  return { adapter: adapterId, capturePath, frames, ...result };
}

export function parseCapture(text: string): InputFrame[] {
  if (/^\s*(event:|data:|:)/m.test(text)) {
    return parseSse(text);
  }
  return parseJsonl(text);
}

function parseJsonl(text: string): InputFrame[] {
  const frames: InputFrame[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "") {
      continue;
    }
    const frame: InputFrame = {
      index: frames.length,
      transport: "jsonl",
      raw: rawLine,
      dataRaw: rawLine
    };
    try {
      frame.data = JSON.parse(rawLine);
    } catch (error) {
      frame.parseError = error instanceof Error ? error.message : String(error);
    }
    frames.push(frame);
  }
  return frames;
}

function parseSse(text: string): InputFrame[] {
  const frames: InputFrame[] = [];
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let rawLines: string[] = [];

  const flush = () => {
    if (rawLines.length === 0) {
      return;
    }
    const dataRaw = dataLines.join("\n");
    const frame: InputFrame = {
      index: frames.length,
      transport: "sse",
      raw: rawLines.join("\n"),
      event: eventName,
      dataRaw
    };
    if (dataRaw.trim() === "[DONE]") {
      frame.done = true;
    } else if (dataRaw.trim() !== "") {
      try {
        frame.data = JSON.parse(dataRaw);
      } catch (error) {
        frame.parseError = error instanceof Error ? error.message : String(error);
      }
    }
    frames.push(frame);
    eventName = undefined;
    dataLines = [];
    rawLines = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) {
      flush();
      frames.push({
        index: frames.length,
        transport: "sse",
        raw: line,
        comment: line.slice(1).trim()
      });
      continue;
    }
    rawLines.push(line);
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  flush();
  return frames;
}
