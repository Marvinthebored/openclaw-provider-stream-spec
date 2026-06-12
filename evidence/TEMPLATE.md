# <Wire family> — provider stream catalogue

Status: draft | Date: | Agent:

## 1. Sources
- Docs: URLs + access date.
- Captures: file paths in `captures/<family>/` + the exact command used (API keys REDACTED).
- If capture was blocked, say why (e.g., "no OPENROUTER_API_KEY in env").

## 2. Frame inventory
| Frame/event type | Key fields | Semantics | Source (docs § / capture file) |
|---|---|---|---|

Every frame type the wire can emit. No "misc" rows.

## 3. Content lanes
How this family carries each lane (or "not supported"):
- Final answer text
- Thinking/reasoning (incl. signed/redacted/summary variants)
- Narration/commentary/preamble (interim assistant text between tool calls)
- Tool calls + results
- Usage/metadata
- Errors

## 4. Ordering & interleaving guarantees
Block/event ordering, whether narration can interleave tool calls, seq/index semantics.

## 5. Delta vs snapshot semantics
Which frames are incremental, which are full snapshots, reassembly rules.

## 6. Termination & final-frame semantics
How a turn ends; how the final answer is distinguished from interim text.

## 7. Observed dialect deviations
Docs-vs-capture mismatches; aggregator quirks (missing frames, renamed fields, collapsed lanes).

## 8. Proposed normalization
Mapping table to OpenClaw streams per the I/O contract
(`reference/agent-event-io-contract-f92c1bf.md`):
`assistant` (phase commentary|final_answer), `thinking`, `tool`/`item`, `lifecycle`.
Must be total over §2.

## 9. Open questions
