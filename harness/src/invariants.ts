import type { NormalizedEvent, ReplayResult } from "./types.ts";

export type InvariantResult = {
  id: string;
  passed: boolean;
  message?: string;
};

export function checkInvariants(result: ReplayResult): InvariantResult[] {
  return [
    checkSeq(result),
    checkOpaqueMaterial(result),
    checkFinalAnswerCardinality(result),
    checkFinalAnswerShape(result),
    checkThinkingShape(result),
    checkFrameConsumption(result),
    checkTerminal(result),
    checkTruncation(result),
    checkNullContent(result),
    checkDialectQuirks(result)
  ];
}

export function assertInvariants(result: ReplayResult): void {
  const failed = checkInvariants(result).filter((entry) => !entry.passed);
  if (failed.length > 0) {
    throw new Error(
      failed
        .map((entry) => `${entry.id}: ${entry.message ?? "failed"}`)
        .join("\n")
    );
  }
}

function pass(id: string): InvariantResult {
  return { id, passed: true };
}

function fail(id: string, message: string): InvariantResult {
  return { id, passed: false, message };
}

function checkSeq(result: ReplayResult): InvariantResult {
  for (let index = 0; index < result.events.length; index += 1) {
    const expected = index + 1;
    if (result.events[index].seq !== expected) {
      return fail("I1", `seq ${result.events[index].seq} at event ${index}, expected ${expected}`);
    }
    if (index > 0 && result.eventSources[index] < result.eventSources[index - 1]) {
      return fail("I1", `event ${index} source frame regressed`);
    }
  }
  return pass("I1");
}

function checkOpaqueMaterial(result: ReplayResult): InvariantResult {
  for (const event of result.events) {
    const hit = findOpaque(event);
    if (hit) {
      return fail("I2", `opaque key/value leaked at ${hit}`);
    }
  }
  return pass("I2");
}

function findOpaque(value: unknown, path = "$"): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findOpaque(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (lower.includes("signature") || lower.includes("encrypted_content")) {
        return `${path}.${key}`;
      }
      if (lower === "reasoning_details" || lower === "encrypted") {
        return `${path}.${key}`;
      }
      const found = findOpaque(nested, `${path}.${key}`);
      if (found) return found;
    }
  }
  return undefined;
}

function checkFinalAnswerCardinality(result: ReplayResult): InvariantResult {
  const finals = finalAnswers(result.events);
  if (finals.length > 1) {
    return fail("I3", `${finals.length} final_answer events`);
  }
  const terminal = terminalLifecycle(result.events);
  const noFinalReasons = new Set(["refusal", "content_filter", "paused", "tool_use", "error", "stream_closed"]);
  if (terminal && noFinalReasons.has(terminal.data.reason ?? "") && finals.length > 0) {
    return fail("I3", `final_answer emitted on ${terminal.data.reason} path`);
  }
  return pass("I3");
}

function checkFinalAnswerShape(result: ReplayResult): InvariantResult {
  for (const event of finalAnswers(result.events)) {
    if ("history" in event.data || event.data.phase === "commentary") {
      return fail("I4", `final_answer ${event.seq} carries commentary/history`);
    }
    if (!event.data.id && typeof event.seq !== "number") {
      return fail("I4", `final_answer ${event.seq} lacks replacement key`);
    }
  }
  return pass("I4");
}

function checkThinkingShape(result: ReplayResult): InvariantResult {
  const valid = new Set(["raw", "summary", "redacted"]);
  for (const event of result.events) {
    if (event.stream !== "thinking") continue;
    if (!valid.has(event.data.variant)) {
      return fail("I5", `invalid thinking variant at seq ${event.seq}`);
    }
    if (event.data.variant === "redacted" && (event.data.delta !== undefined || event.data.text !== undefined)) {
      return fail("I5", `redacted marker carried content at seq ${event.seq}`);
    }
  }
  return pass("I5");
}

function checkFrameConsumption(result: ReplayResult): InvariantResult {
  const consumed = new Set(result.dispositions.map((entry) => entry.frameIndex));
  for (const frame of result.frames) {
    if (!consumed.has(frame.index)) {
      return fail("I6", `frame ${frame.index} unconsumed: ${frame.raw.slice(0, 120)}`);
    }
  }
  return pass("I6");
}

function checkTerminal(result: ReplayResult): InvariantResult {
  const terminals = result.events.filter(
    (event) => event.stream === "lifecycle" && (event.data.phase === "end" || event.data.phase === "error")
  );
  if (terminals.length !== 1) {
    return fail("I7", `${terminals.length} terminal lifecycle events`);
  }
  return pass("I7");
}

function checkTruncation(result: ReplayResult): InvariantResult {
  const terminal = terminalLifecycle(result.events);
  const final = finalAnswers(result.events)[0];
  const isTruncate = terminal?.data.reason === "truncated";
  if (isTruncate !== Boolean(final?.data.truncated)) {
    return fail("I8", `truncated terminal=${isTruncate} final=${Boolean(final?.data.truncated)}`);
  }
  return pass("I8");
}

function checkNullContent(result: ReplayResult): InvariantResult {
  for (const event of result.events) {
    if (event.stream !== "assistant") continue;
    if (event.data.delta === "" || event.data.text === "") {
      return fail("I9", `empty assistant text at seq ${event.seq}`);
    }
  }
  return pass("I9");
}

function checkDialectQuirks(result: ReplayResult): InvariantResult {
  if (result.adapter !== "f2") {
    return pass("I10");
  }
  if (result.observed.sawDone === false) {
    return pass("I10");
  }
  if (result.observed.usageLocations?.some((location) => !["top-level", "choice", "delta"].includes(location))) {
    return fail("I10", "unknown usage location");
  }
  return pass("I10");
}

function finalAnswers(events: NormalizedEvent[]): Array<Extract<NormalizedEvent, { stream: "assistant" }>> {
  return events.filter(
    (event): event is Extract<NormalizedEvent, { stream: "assistant" }> =>
      event.stream === "assistant" && event.data.phase === "final_answer"
  );
}

function terminalLifecycle(events: NormalizedEvent[]): Extract<NormalizedEvent, { stream: "lifecycle" }> | undefined {
  return events.find(
    (event): event is Extract<NormalizedEvent, { stream: "lifecycle" }> =>
      event.stream === "lifecycle" && (event.data.phase === "end" || event.data.phase === "error")
  );
}
