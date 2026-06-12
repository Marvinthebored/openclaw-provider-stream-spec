# Moonshot / Kimi captures

Model line status (per Peter, 2026-06-12):

- **kimi-k2.6** — the standard Kimi thinking model; the one everyone will be using.
  GOLDEN: `kimi-k2.6.sse` (52KB, 212 `reasoning_content` deltas — deepseek-style F2
  dialect; covered by SPEC §6 F2 rules, no F-family of its own).
- **kimi-k2.5** — legacy, still served. Not captured; same dialect expected.
- **Kimi-K2-Thinking** — DEPRECATED on the Moonshot API (this is why
  `kimi-k2-thinking` / `kimi-thinking-preview` / `kimi-k2-thinking-turbo` probes all
  returned `resource_not_found_error`). Being open-weights, self-hosted instances may
  persist — those arrive via the inference server's re-exposure dialect (ollama
  native / OpenAI-compat `reasoning_content`), covered by the same rules as gpt-oss
  re-exposure; the model needs no wire family of its own. Not worth a dedicated
  Moonshot-API golden.
- **moonshot-v1-** line — older generation, no thinking lane, out of scope for the
  pipeline spec. `moonshot-v1-8k.sse` kept only as a base-dialect sample.

API notes: `api.moonshot.ai` chat/completions accepts the key; `/v1/models` is
auth-walled for this key (same pattern as pioneer). `capture.sh` targets
`kimi-k2.6` + `moonshot-v1-8k`.
