#!/bin/bash
# Gemini streamGenerateContent SSE with thoughts included (NEW wire family F5)
set -euo pipefail
: "${GEMINI_API_KEY:?GEMINI_API_KEY not set}"
cd "$(dirname "$0")"
curl -sS "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse" \
  -H "Content-Type: application/json" -H "x-goog-api-key: $GEMINI_API_KEY" \
  -d '{"contents":[{"parts":[{"text":"What is 17*23? Think briefly; answer with just the number."}]}],"generationConfig":{"maxOutputTokens":400,"thinkingConfig":{"includeThoughts":true}}}' \
  > gemini-2.5-flash-thinking.sse
