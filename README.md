# OpenClaw Provider Stream Spec

A **target specification** for OpenClaw's provider→channel content pipeline: every kind
of provider output — final text, narration/commentary, thinking/reasoning, tool
activity, usage, errors — normalized into one provider-agnostic event stream, always
archived, and projected by each channel to the best of its ability.

**One-line design principle: emit always, archive always, gate only at presentation.**

## Status

Draft v0.4. Twice independently red-teamed (Claude + Codex adversarial passes, 43
findings folded), and reconciled against a live capture library spanning ~10 provider
dialects. UX policy for the Discord reference projection is ratified. The conformance replay
harness is included (`harness/`) and **green**: 18 tests passing — 17 golden captures
replayed through reference F1/F1e/F2 adapters with all ten spec invariants asserted
(F3/F5 adapters stubbed, marked todo). Reproduce: `cd harness && npm install && npx
vitest run`.

## Relationship to the upstream I/O contract

This builds directly on ragesaq's `agent-event-io-contract` (OpenClaw PR #92216 —
[supportive comment + amendment preview](https://github.com/openclaw/openclaw/pull/92216#issuecomment-4687559931)).
That doc is **descriptive** — it documents the boundary as it exists. This spec is
**prescriptive** — the target definition layered on top. It makes exactly four explicit
amendments to the base contract, marked `[AMENDS BASE]` in `SPEC.md` (§3.2 emit-always
thinking, §3.3 tool-start timing, §5.1 thinking in the hidden mirror, §7.3 idempotency
key order). Everything else is additive. A frozen copy of the base contract as
referenced is in `evidence/agent-event-io-contract-f92c1bf.md`.

## Layout

- **`SPEC.md`** — the specification. Start here.
- **`HARNESS-DESIGN.md`** — how the spec becomes executable (replay goldens through
  reference adapters; invariants).
- **`evidence/`** — per-wire-family catalogues (Anthropic SSE, claude-cli stream-json,
  Chat Completions + dialect notes, Responses API, Harmony incl. live ollama
  re-exposure, Gemini) and the OpenClaw internals audit that motivated the settings
  model.
- **`evidence/captures/`** — the golden capture library: real streamed responses from
  live APIs (Anthropic, OpenAI CC + Responses, OpenRouter ×3 models, deepseek native,
  Kimi K2.6, pioneer, gemini, gpt-oss via ollama both surfaces, claude-cli). These
  double as conformance fixtures. claude-cli captures are lightly scrubbed (paths,
  session ids, costs); all content frames are byte-faithful.
- **`red-team/`** — both adversarial review reports and the brief that produced them.

## How to interrogate the spec

It is designed to answer questions mechanically. Test it with queries of the form:
*"provider X via transport Y, `/reasoning` A, `/verbose` B, channel tier T — what
exactly renders?"* — §3.5 (finality dispatch), §4.3 (settings truth table), §6
(per-family normalization) and §7 (channel tiers) should determine the answer without
interpretation. If you find a query they don't determine, that's a bug — issues
welcome.

## Provenance

Built by Peter Lindsey's agent tooling (Claude + Codex assistance) against OpenClaw
v2026.6.5 + live captures, 2026-06-12. Spec text and evidence are offered upstream —
reuse freely (MIT).
