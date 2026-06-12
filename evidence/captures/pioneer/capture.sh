#!/usr/bin/env bash
# Live capture of the pioneer aggregator's streaming wire format.
#
# Follow-up to evidence/pioneer-dialect.md §9 "Open questions" — run this once
# $PIONEER_API_KEY is exported (e.g. after Peter exports a key). This script
# never echoes the key; it is only read into a curl header.
#
# Base URL and request shape are derived from the only pioneer fixture found
# in the OpenClaw repo (src/agents/openai-transport-stream.test.ts:1588-1627):
#   api: "openai-completions", baseUrl: "https://api.pioneer.ai/v1",
#   model id: "claude-opus-4-8"
# This is UNVERIFIED against a real pioneer endpoint — adjust PIONEER_BASE_URL
# and PIONEER_MODEL below if the real catalog entry differs (see
# pioneer-dialect.md §9 for why this is uncertain).
#
# Usage:
#   export PIONEER_API_KEY=...   # never echo or log this value
#   ./capture.sh
#
# Output: raw SSE chunks saved to ./stream.jsonl (one JSON object per `data:`
# line, plus a separate ./raw-sse.txt with the unprocessed SSE bytes).

set -euo pipefail

: "${PIONEER_API_KEY:?Set PIONEER_API_KEY in the environment (not in this script) before running.}"

PIONEER_BASE_URL="${PIONEER_BASE_URL:-https://api.pioneer.ai/v1}"
PIONEER_MODEL="${PIONEER_MODEL:-claude-opus-4-8}"

OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_SSE="${OUT_DIR}/raw-sse.txt"
STREAM_JSONL="${OUT_DIR}/stream.jsonl"
RAW_THINKING_SSE="${OUT_DIR}/raw-sse-thinking.txt"
STREAM_THINKING_JSONL="${OUT_DIR}/stream-thinking.jsonl"

run_capture() {
  local prompt="$1"
  local raw_out="$2"
  local jsonl_out="$3"

  curl -sS -N "${PIONEER_BASE_URL%/}/chat/completions" \
    -H "Authorization: Bearer ${PIONEER_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(cat <<JSON
{
  "model": "${PIONEER_MODEL}",
  "stream": true,
  "stream_options": { "include_usage": true },
  "messages": [
    { "role": "user", "content": ${prompt} }
  ]
}
JSON
)" > "${raw_out}"

  # Extract each `data: {...}` payload onto its own line, dropping `[DONE]`.
  grep -E '^data: ' "${raw_out}" \
    | sed -E 's/^data: //' \
    | grep -v '^\[DONE\]$' \
    > "${jsonl_out}" || true
}

echo "Capturing plain completion..."
run_capture '"Reply with exactly: capture-ok"' "${RAW_SSE}" "${STREAM_JSONL}"
echo "  -> ${STREAM_JSONL} ($(wc -l < "${STREAM_JSONL}" | tr -d ' ') frames)"

echo "Capturing reasoning-eliciting completion..."
run_capture '"Think step by step: what is 17*23? Show only the final number."' \
  "${RAW_THINKING_SSE}" "${STREAM_THINKING_JSONL}"
echo "  -> ${STREAM_THINKING_JSONL} ($(wc -l < "${STREAM_THINKING_JSONL}" | tr -d ' ') frames)"

echo "Done. Inspect ${STREAM_JSONL} and ${STREAM_THINKING_JSONL} for:"
echo "  - presence/absence of reasoning_content / reasoning / reasoning_text / reasoning_details"
echo "  - whether usage arrives mid-stream or only on a final chunk"
echo "  - any wrapper envelope around the chat.completion.chunk objects"
