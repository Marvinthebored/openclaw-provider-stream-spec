import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { fixturePath, implementedGoldens, pendingGoldens } from "../src/goldens.ts";
import { assertInvariants } from "../src/invariants.ts";
import { replayCapture } from "../src/replay.ts";
import type { NormalizedEvent } from "../src/types.ts";
import { f2ChatCompletionsAdapter } from "../src/adapters/f2-chat-completions.ts";
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

function readJsonl(path: string): NormalizedEvent[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as NormalizedEvent);
}
