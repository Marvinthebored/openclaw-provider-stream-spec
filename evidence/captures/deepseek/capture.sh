#!/bin/bash
# deepseek native dialect: reasoning_content sibling deltas (F2 deepseek dialect)
set -euo pipefail
: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY not set}"
cd "$(dirname "$0")"
curl -sS https://api.deepseek.com/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -d '{"model":"deepseek-reasoner","stream":true,"max_tokens":200,"messages":[{"role":"user","content":"What is 17*23? Think briefly; answer with just the number."}]}' \
  > deepseek-reasoner.sse
