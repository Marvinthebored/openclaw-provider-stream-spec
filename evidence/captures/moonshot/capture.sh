#!/bin/bash
# moonshot/Kimi: OpenAI-compatible dialect; probe thinking + base models
set -euo pipefail
: "${MOONSHOT_API_KEY:?MOONSHOT_API_KEY not set}"
cd "$(dirname "$0")"
for m in kimi-k2.6 moonshot-v1-8k; do
  curl -sS https://api.moonshot.ai/v1/chat/completions \
    -H "Content-Type: application/json" -H "Authorization: Bearer $MOONSHOT_API_KEY" \
    -d "{\"model\":\"$m\",\"stream\":true,\"max_tokens\":200,\"messages\":[{\"role\":\"user\",\"content\":\"What is 17*23? Think briefly; answer with just the number.\"}]}" \
    > "$m.sse" || true
done
