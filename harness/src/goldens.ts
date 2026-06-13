import type { AdapterId } from "./types.ts";

export type Golden = {
  name: string;
  adapter: AdapterId;
  capture: string;
  fixture: string;
  implemented: boolean;
  expectTranscriptKinds?: string[];
};

const implemented = true;
const pending = false;

export const goldens: Golden[] = [
  golden("f1 anthropic text", "f1", "../evidence/captures/anthropic/01-text-stream.sse", implemented),
  golden("f1 anthropic thinking", "f1", "../evidence/captures/anthropic/02-thinking-stream.sse", implemented, [
    "anthropic_signature_delta"
  ]),
  golden("f1 anthropic tool use", "f1", "../evidence/captures/anthropic/03-tool-use-stream.sse", implemented),

  golden("f1e claude cli plain", "f1e", "../evidence/captures/claude-cli/plain.jsonl", implemented, [
    "anthropic_signature_delta",
    "claude_cli_snapshot_signature"
  ]),
  golden("f1e claude cli reasoning", "f1e", "../evidence/captures/claude-cli/reasoning.jsonl", implemented),

  golden("f2 pioneer stream", "f2", "../evidence/captures/pioneer/stream.jsonl", implemented),
  golden("f2 pioneer stream thinking request", "f2", "../evidence/captures/pioneer/stream-thinking.jsonl", implemented),
  golden("f2 openrouter claude sonnet", "f2", "../evidence/captures/openrouter/claude-sonnet.sse", implemented, [
    "openrouter_reasoning_signature"
  ]),
  golden("f2 openrouter deepseek r1", "f2", "../evidence/captures/openrouter/deepseek-r1.sse", implemented),
  golden("f2 openrouter gpt 5 mini", "f2", "../evidence/captures/openrouter/gpt-5-mini.sse", implemented, [
    "openrouter_reasoning_encrypted"
  ]),
  golden("f2 deepseek direct reasoner", "f2", "../evidence/captures/deepseek/deepseek-reasoner.sse", implemented),
  golden("f2 moonshot kimi k2.6", "f2", "../evidence/captures/moonshot/kimi-k2.6.sse", implemented),
  golden("f2 moonshot v1 8k", "f2", "../evidence/captures/moonshot/moonshot-v1-8k.sse", implemented),
  golden("f2 gpt oss openai compat", "f2", "../evidence/captures/gpt-oss/openai-compat.sse", implemented),
  golden("f2 gpt oss openai compat tools", "f2", "../evidence/captures/gpt-oss/openai-compat-tools.sse", implemented),
  golden("f2 gpt oss compat preamble", "f2", "../evidence/captures/gpt-oss/compat-preamble.sse", implemented),
  golden("ollama native default", "ollama-native", "../evidence/captures/gpt-oss/native-default.jsonl", implemented),
  golden("ollama native think low", "ollama-native", "../evidence/captures/gpt-oss/native-think-low.jsonl", implemented),
  golden("ollama native tools", "ollama-native", "../evidence/captures/gpt-oss/native-tools.jsonl", implemented),
  golden("ollama native preamble", "ollama-native", "../evidence/captures/gpt-oss/native-preamble.jsonl", implemented),
  golden("f2 openai cc tool call", "f2", "../evidence/captures/openai/cc-tool-call.sse", implemented),

  golden("f3 openai responses reasoning", "f3", "../evidence/captures/openai/responses-reasoning.sse", implemented),
  golden("f3 openai responses reasoning o4 mini", "f3", "../evidence/captures/openai/responses-reasoning-o4-mini.sse", implemented),
  golden("f5 gemini thinking", "f5", "../evidence/captures/gemini/gemini-2.5-flash-thinking.sse", implemented),
  golden("f5 gemini thinking long", "f5", "../evidence/captures/gemini/gemini-2.5-flash-thinking-long.sse", implemented),
  golden("f5 gemini tool thinking", "f5", "../evidence/captures/gemini/gemini-2.5-flash-tool-thinking.sse", implemented, [
    "gemini_thought_signature"
  ]),

  golden("codex app-server reasoning", "codex-appserver", "../evidence/captures/codex/codex-appserver-reasoning.jsonl", implemented, [
    "codex_raw_reasoning"
  ]),
  golden("codex app-server tool use", "codex-appserver", "../evidence/captures/codex/codex-appserver-tooluse.jsonl", implemented, [
    "codex_raw_reasoning"
  ])
];

export const implementedGoldens = goldens.filter((entry) => entry.implemented);
export const pendingGoldens = goldens.filter((entry) => !entry.implemented);

export function fixturePath(golden: Golden): string {
  return `fixtures/expected/${golden.fixture}.jsonl`;
}

function golden(
  name: string,
  adapter: AdapterId,
  capture: string,
  isImplemented: boolean,
  expectTranscriptKinds?: string[]
): Golden {
  return {
    name,
    adapter,
    capture,
    implemented: isImplemented,
    fixture: `${adapter}__${capture
      .replace(/^\.\.\/evidence\/captures\//, "")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")}`,
    expectTranscriptKinds
  };
}
