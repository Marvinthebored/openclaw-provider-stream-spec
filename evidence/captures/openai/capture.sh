#!/usr/bin/env bash
# Capture OpenAI streaming wire formats for the provider-content-pipeline evidence set.
#
# Requires OPENAI_API_KEY to be exported in the environment. This script never
# echoes, logs, or prints the key or any Authorization header value.
#
# Usage:
#   export OPENAI_API_KEY=sk-...
#   ./capture.sh
#
# Output files (written next to this script):
#   cc-tool-call.sse        - Chat Completions streaming response with a tool call (gpt-4.1-mini)
#   responses-reasoning.sse - Responses API streaming response from a reasoning model
#                             with summary enabled (gpt-5-mini, low effort, small max output)

set -euo pipefail

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "OPENAI_API_KEY is not set. Export it and re-run." >&2
  exit 1
fi

OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- (a) Chat Completions SSE stream with a tool call (gpt-4.1-mini) ---------
curl -sS https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -d '{
    "model": "gpt-4.1-mini",
    "stream": true,
    "stream_options": {"include_usage": true},
    "messages": [
      {"role": "user", "content": "What is the weather like in Boston, MA right now? Use the get_weather tool."}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get the current weather for a location",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {"type": "string", "description": "City and state, e.g. Boston, MA"}
            },
            "required": ["location"]
          }
        }
      }
    ]
  }' \
  -o "${OUT_DIR}/cc-tool-call.sse"

echo "Wrote ${OUT_DIR}/cc-tool-call.sse"

# --- (b) Responses API stream, reasoning model, summary enabled --------------
# low reasoning effort + small max_output_tokens to keep the capture cheap/short.
curl -sS https://api.openai.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -d '{
    "model": "gpt-5-mini",
    "stream": true,
    "max_output_tokens": 256,
    "reasoning": {"effort": "low", "summary": "auto"},
    "input": [
      {"role": "user", "content": "In one short sentence, why is the sky blue?"}
    ]
  }' \
  -o "${OUT_DIR}/responses-reasoning.sse"

echo "Wrote ${OUT_DIR}/responses-reasoning.sse"
