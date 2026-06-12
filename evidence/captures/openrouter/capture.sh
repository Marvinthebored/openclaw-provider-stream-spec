#!/usr/bin/env bash
# Capture OpenRouter streaming wire formats for the provider-content-pipeline evidence set.
#
# Requires OPENROUTER_API_KEY to be exported in the environment. This script never
# echoes, logs, or prints the key or any Authorization header value.
#
# Usage:
#   export OPENROUTER_API_KEY=sk-or-...
#   ./capture.sh
#
# Output files (written next to this script):
#   deepseek-r1.sse   - DeepSeek R1 via OpenRouter, reasoning streamed as
#                        reasoning_details (reasoning.text, deepseek-style "format")
#   claude-sonnet.sse - Anthropic Claude Sonnet 4.6 via OpenRouter, reasoning
#                        enabled (reasoning.max_tokens) -> Anthropic-style
#                        reasoning_details with signature
#   gpt-5-mini.sse    - OpenAI GPT-5 mini via OpenRouter, reasoning effort set
#                        -> openai-responses-v1 reasoning_details, possibly
#                        encrypted/summary variants
#
# Same prompt and same small max_tokens budget are used for all three so the
# dialect differences are directly comparable frame-for-frame.

set -euo pipefail

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "OPENROUTER_API_KEY is not set. Export it and re-run." >&2
  exit 1
fi

OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROMPT='A farmer has 17 sheep. All but 9 die. How many are left? Explain your reasoning in one short sentence, then give the final number.'

# --- (a) DeepSeek R1 -----------------------------------------------------------
curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
  -d '{
    "model": "deepseek/deepseek-r1",
    "stream": true,
    "stream_options": {"include_usage": true},
    "max_tokens": 300,
    "reasoning": {"max_tokens": 100},
    "messages": [
      {"role": "user", "content": "'"${PROMPT}"'"}
    ]
  }' \
  -o "${OUT_DIR}/deepseek-r1.sse"

echo "Wrote ${OUT_DIR}/deepseek-r1.sse"

# --- (b) Anthropic Claude Sonnet 4.6, reasoning enabled -------------------------
curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
  -d '{
    "model": "anthropic/claude-sonnet-4.6",
    "stream": true,
    "stream_options": {"include_usage": true},
    "max_tokens": 300,
    "reasoning": {"max_tokens": 1024},
    "messages": [
      {"role": "user", "content": "'"${PROMPT}"'"}
    ]
  }' \
  -o "${OUT_DIR}/claude-sonnet.sse"

echo "Wrote ${OUT_DIR}/claude-sonnet.sse"

# --- (c) OpenAI GPT-5 mini, reasoning effort set ---------------------------------
curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
  -d '{
    "model": "openai/gpt-5-mini",
    "stream": true,
    "stream_options": {"include_usage": true},
    "max_tokens": 300,
    "reasoning": {"effort": "low"},
    "messages": [
      {"role": "user", "content": "'"${PROMPT}"'"}
    ]
  }' \
  -o "${OUT_DIR}/gpt-5-mini.sse"

echo "Wrote ${OUT_DIR}/gpt-5-mini.sse"
