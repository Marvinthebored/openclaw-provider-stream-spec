# Conformance replay harness — design

Goal: make SPEC.md executable. Feed each golden capture through a reference normalizer
for its wire family; assert the emitted normalized-event sequence against a reviewed
fixture; assert spec invariants hold on every run. This harness is (a) the proof the
spec is implementable, (b) the test bed the migration-map code changes are judged
against, (c) transplantable into openclaw's vitest suites later.

## Layout (TypeScript, vitest, pnpm; lives in `harness/` here — NOT in ~/openclaw)

    harness/
      package.json            # vitest + tsx only; no openclaw deps
      src/types.ts            # NormalizedEvent per SPEC §3 (assistant/thinking/item/lifecycle)
      src/invariants.ts       # cross-cutting assertions, see below
      src/adapters/f1-anthropic-sse.ts
      src/adapters/f2-chat-completions.ts   # incl. dialect handling per SPEC §6 F2 row
      src/adapters/f1e-claude-cli.ts        # envelope over f1
      src/adapters/f3-responses.ts
      src/adapters/f5-gemini.ts
      src/replay.ts           # capture file -> frames -> adapter -> NormalizedEvent[]
      test/<family>.test.ts   # one test per golden: replay vs fixtures/expected/*
      fixtures/expected/      # reviewed expected-event JSONL per capture (bootstrap, then frozen)
      tools/bootstrap.ts      # generate draft expected fixtures for human review

## Reference adapters

Implement SPEC §6 mapping tables + §3.5 finality dispatch EXACTLY — they are the spec's
executable form, not production code. Where the spec says "adapter transcript only",
the adapter emits nothing and records the material in a side-channel `transcript[]`
the tests can assert on (e.g. signatures present in transcript, absent from events).

## Invariants (run on every replay, every family)

I1  seq strictly increasing; emission order == frame order
I2  no signature/encrypted material in any event payload (deep scan)
I3  at most one final_answer per turn; none on Reject/Suspend/Dead/tool-yield paths
I4  final_answer never carries phase commentary history (replacement key present: id or seq)
I5  thinking events carry valid variant; redacted markers are content-free
I6  every input frame consumed exactly once: event(s) | transcript | documented-drop | diagnostic
I7  lifecycle terminal exactly once; stream-death synthesis when capture ends abruptly
I8  truncated flag present iff dispatch path was Truncate
I9  null-content (deepseek) treated as absent — no empty-text assistant events
I10 dialect quirks honored: usage found in all three F2 locations; [DONE] optional

## Goldens wired in (evidence/captures/)

F1: anthropic/01-03 · F1e: claude-cli/plain,reasoning · F2: pioneer/2, openrouter/3,
deepseek/1, moonshot/2, gpt-oss/openai-compat ×2(+preamble) · F3: openai/cc-tool-call
(F2), responses-reasoning-o4-mini + failed-stream (Dead path) · F5: gemini/3
Ollama-native (gpt-oss/native-*.jsonl): envelope adapter optional, stretch goal.

## Definition of done

`pnpm test` green on marvinmbp AND pmac; bootstrap fixtures generated + flagged for
Peter/Doc review; one CONFORMANCE.md table: capture × adapter × invariants → pass.
