import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { fixturePath, implementedGoldens, pendingGoldens } from "../src/goldens.ts";
import { assertInvariants } from "../src/invariants.ts";
import { replayCapture } from "../src/replay.ts";
import type { NormalizedEvent } from "../src/types.ts";
import { f2ChatCompletionsAdapter } from "../src/adapters/f2-chat-completions.ts";
import { f3ResponsesAdapter } from "../src/adapters/f3-responses.ts";
import { f5GeminiAdapter } from "../src/adapters/f5-gemini.ts";
import { ollamaNativeAdapter } from "../src/adapters/ollama-native.ts";
import { parseCapture } from "../src/replay.ts";

describe("golden replay conformance", () => {
  for (const golden of implementedGoldens) {
    test(golden.name, () => {
      const result = replayCapture(resolve(golden.capture), golden.adapter);
      assertInvariants(result);

      for (const kind of golden.expectTranscriptKinds ?? []) {
        expect(result.transcript.some((entry) => entry.kind === kind), kind).toBe(true);
      }

      const expectedPath = resolve(fixturePath(golden));
      expect(existsSync(expectedPath), `${expectedPath} missing; run pnpm bootstrap`).toBe(true);
      expect(result.events).toEqual(readJsonl(expectedPath));
    });
  }

  for (const golden of pendingGoldens) {
    test.todo(`${golden.name} (${golden.adapter})`);
  }
});

describe("f2 dialect variance", () => {
  test("captures usage in top-level, choice, and delta locations", () => {
    const synthetic = [
      '{"id":"a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"total_tokens":1}}',
      '{"id":"b","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"y"},"finish_reason":"stop","usage":{"total_tokens":2}}]}',
      '{"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"z","usage":{"total_tokens":3}},"finish_reason":"stop"}]}'
    ];

    const seen = new Set<string>();
    for (const line of synthetic) {
      const frames = parseCapture(line);
      const result = f2ChatCompletionsAdapter.normalize(frames, "synthetic.jsonl");
      assertInvariants({ ...result, adapter: "f2", capturePath: "synthetic.jsonl", frames });
      for (const location of result.observed.usageLocations ?? []) {
        seen.add(location);
      }
    }

    expect([...seen].sort()).toEqual(["choice", "delta", "top-level"]);
  });
});

describe("f3 Responses dispatch", () => {
  test("routes token-limit incomplete to Truncate", () => {
    const frames = parseCapture(jsonl([
      responseCreated("resp_truncate"),
      messageAdded("msg_truncate"),
      outputTextDelta("msg_truncate", "partial"),
      responseIncomplete("resp_truncate", "max_output_tokens", "partial")
    ]));
    const result = f3ResponsesAdapter.normalize(frames, "synthetic-f3-truncate.jsonl");

    assertInvariants({ ...result, adapter: "f3", capturePath: "synthetic-f3-truncate.jsonl", frames });
    const final = result.events.find((event) => event.stream === "assistant" && event.data.phase === "final_answer");
    expect(final?.data.truncated).toBe(true);
    expect(terminal(result.events)?.data.reason).toBe("truncated");
  });

  test("routes content-filter incomplete to Reject with no final answer", () => {
    const frames = parseCapture(jsonl([
      responseCreated("resp_filter"),
      messageAdded("msg_filter"),
      outputTextDelta("msg_filter", "unsafe partial"),
      responseIncomplete("resp_filter", "content_filter", "unsafe partial")
    ]));
    const result = f3ResponsesAdapter.normalize(frames, "synthetic-f3-filter.jsonl");

    assertInvariants({ ...result, adapter: "f3", capturePath: "synthetic-f3-filter.jsonl", frames });
    expect(result.events.some((event) => event.stream === "assistant" && event.data.phase === "final_answer")).toBe(false);
    expect(terminal(result.events)?.data.reason).toBe("content_filter");
  });
});

describe("f5 Gemini dispatch", () => {
  test("routes MAX_TOKENS to Truncate", () => {
    const frames = parseCapture(jsonl([
      geminiText("partial", "MAX_TOKENS")
    ]));
    const result = f5GeminiAdapter.normalize(frames, "synthetic-f5-max-tokens.jsonl");

    assertInvariants({ ...result, adapter: "f5", capturePath: "synthetic-f5-max-tokens.jsonl", frames });
    const final = result.events.find((event) => event.stream === "assistant" && event.data.phase === "final_answer");
    expect(final?.data.truncated).toBe(true);
    expect(terminal(result.events)?.data.reason).toBe("truncated");
  });

  test.each([
    ["SAFETY", "content_filter"],
    ["RECITATION", "content_filter"],
    ["OTHER", "incomplete"]
  ])("routes %s without a final answer", (finishReason, expectedReason) => {
    const frames = parseCapture(jsonl([
      geminiText("partial", finishReason)
    ]));
    const result = f5GeminiAdapter.normalize(frames, `synthetic-f5-${finishReason}.jsonl`);

    assertInvariants({ ...result, adapter: "f5", capturePath: `synthetic-f5-${finishReason}.jsonl`, frames });
    expect(result.events.some((event) => event.stream === "assistant" && event.data.phase === "final_answer")).toBe(false);
    expect(terminal(result.events)?.data.reason).toBe(expectedReason);
  });

  test("stores thoughtSignature only in transcript and fails malformed function calls", () => {
    const frames = parseCapture(jsonl([
      geminiFunctionCall("MALFORMED_FUNCTION_CALL")
    ]));
    const result = f5GeminiAdapter.normalize(frames, "synthetic-f5-malformed-tool.jsonl");

    assertInvariants({ ...result, adapter: "f5", capturePath: "synthetic-f5-malformed-tool.jsonl", frames });
    expect(result.transcript.some((entry) => entry.kind === "gemini_thought_signature")).toBe(true);
    expect(JSON.stringify(result.events)).not.toContain("thoughtSignature");
    expect(result.events.some((event) => event.stream === "item" && event.data.phase === "end" && event.data.status === "failed")).toBe(true);
    expect(terminal(result.events)?.data.reason).toBe("error");
  });
});

describe("ollama native envelope", () => {
  test("preserves native tool arguments as objects", () => {
    const frames = parseCapture(jsonl([
      {
        model: "gpt-oss:20b",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_object_args",
              function: {
                index: 0,
                name: "get_weather",
                arguments: { city: "Tokyo" }
              }
            }
          ]
        },
        done: true,
        done_reason: "stop"
      }
    ]));
    const result = ollamaNativeAdapter.normalize(frames, "synthetic-ollama-native-tool.jsonl");

    assertInvariants({ ...result, adapter: "ollama-native", capturePath: "synthetic-ollama-native-tool.jsonl", frames });
    const end = result.events.find(
      (event): event is Extract<NormalizedEvent, { stream: "item" }> =>
        event.stream === "item" && event.data.phase === "end"
    );
    expect(end?.data.arguments).toEqual({ city: "Tokyo" });
    expect(typeof end?.data.arguments).toBe("object");
    expect(terminal(result.events)?.data.reason).toBe("tool_use");
  });
});

function readJsonl(path: string): NormalizedEvent[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as NormalizedEvent);
}

function jsonl(values: unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n");
}

function responseCreated(id: string): unknown {
  return {
    type: "response.created",
    response: { id, model: "o4-mini-test", usage: null }
  };
}

function messageAdded(id: string): unknown {
  return {
    type: "response.output_item.added",
    item: { id, type: "message", status: "in_progress", content: [], role: "assistant" },
    output_index: 0
  };
}

function outputTextDelta(itemId: string, delta: string): unknown {
  return {
    type: "response.output_text.delta",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta
  };
}

function responseIncomplete(id: string, reason: string, text: string): unknown {
  return {
    type: "response.incomplete",
    response: {
      id,
      model: "o4-mini-test",
      status: "incomplete",
      incomplete_details: { reason },
      output: [
        {
          id: id.replace("resp", "msg"),
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text }]
        }
      ],
      usage: { output_tokens_details: { reasoning_tokens: 0 } }
    }
  };
}

function geminiText(text: string, finishReason: string): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text }], role: "model" },
        finishReason,
        index: 0
      }
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    modelVersion: "gemini-test",
    responseId: `resp_${finishReason.toLowerCase()}`
  };
}

function geminiFunctionCall(finishReason: string): unknown {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: { name: "get_weather", args: { city: "Tokyo" } },
              thoughtSignature: "opaque-signature"
            }
          ],
          role: "model"
        },
        finishReason,
        index: 0
      }
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 3, totalTokenCount: 5 },
    modelVersion: "gemini-test",
    responseId: "resp_tool"
  };
}

function terminal(events: NormalizedEvent[]): Extract<NormalizedEvent, { stream: "lifecycle" }> | undefined {
  return events.find(
    (event): event is Extract<NormalizedEvent, { stream: "lifecycle" }> =>
      event.stream === "lifecycle" && (event.data.phase === "end" || event.data.phase === "error")
  );
}
