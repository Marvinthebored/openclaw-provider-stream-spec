#!/usr/bin/env bash
# Capture Anthropic Messages API streaming wire formats for the
# provider-content-pipeline evidence set.
#
# Requires ANTHROPIC_API_KEY to be exported in the environment. This script
# never echoes, logs, or prints the key or any auth header value.
#
# Usage:
#   export ANTHROPIC_API_KEY=sk-ant-...
#   ./capture.sh
#
# Output files (written next to this script):
#   01-text-stream.sse      - Plain streamed text (claude-haiku-4-5-20251001, max_tokens 100)
#   02-thinking-stream.sse  - Extended thinking enabled (claude-sonnet-4-6, budget_tokens 1024)
#   03-tool-use-stream.sse  - Forced tool_use with a dummy get_weather tool

set -euo pipefail

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY is not set. Export it and re-run." >&2
  exit 1
fi

OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_VERSION="2023-06-01"

# --- (a) Plain streamed text (claude-haiku-4-5-20251001) ---------------------
curl -sS https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "anthropic-version: ${API_VERSION}" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Say hello in one short sentence."}
    ]
  }' \
  -o "${OUT_DIR}/01-text-stream.sse"

echo "Wrote ${OUT_DIR}/01-text-stream.sse"

# --- (b) Extended thinking enabled (claude-sonnet-4-6) ------------------------
# Small reasoning question, small budget to keep the capture cheap/short.
curl -sS https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "anthropic-version: ${API_VERSION}" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 2048,
    "stream": true,
    "thinking": {
      "type": "enabled",
      "budget_tokens": 1024
    },
    "messages": [
      {"role": "user", "content": "What is the greatest common divisor of 84 and 30? Think step by step."}
    ]
  }' \
  -o "${OUT_DIR}/02-thinking-stream.sse"

echo "Wrote ${OUT_DIR}/02-thinking-stream.sse"

# --- (c) Tool use, forced call with a dummy tool ------------------------------
curl -sS https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "anthropic-version: ${API_VERSION}" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 256,
    "stream": true,
    "tools": [
      {
        "name": "get_weather",
        "description": "Get the current weather in a given location",
        "input_schema": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "The city and state, e.g. San Francisco, CA"
            }
          },
          "required": ["location"]
        }
      }
    ],
    "tool_choice": {"type": "any"},
    "messages": [
      {"role": "user", "content": "What is the weather like in San Francisco?"}
    ]
  }' \
  -o "${OUT_DIR}/03-tool-use-stream.sse"

echo "Wrote ${OUT_DIR}/03-tool-use-stream.sse"
