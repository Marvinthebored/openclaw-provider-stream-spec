# Red-team brief: SPEC.md adversarial review

You are reviewing `SPEC.md` (normalized provider-stream spec for OpenClaw) against the
evidence library in `evidence/` (six wire-format catalogues; treat them as ground truth)
and the base contract `reference/agent-event-io-contract-f92c1bf.md`.

Your job is to break the spec, not to praise it. Write findings to `RED-TEAM-codex.md`
in this directory. For each finding: severity (BLOCKER / MAJOR / MINOR / NIT), the spec
section, the failure scenario, and — where you can — the concrete fix.

Attack surfaces, in priority order:

1. **Mapping totality.** For each family catalogue's §2 frame inventory, is every frame
   type given exactly one disposition by SPEC.md §6 + §3? Find frames that fall through.
2. **Finality algorithm (§3.5).** Construct event sequences where the re-tagging rule
   double-posts, loses the final answer, or misclassifies: aborts mid-segment,
   `max_tokens` truncation mid-final-segment, F2 `content_filter`, F3 `response.incomplete`,
   parallel tool calls, zero-text turns (tool-only), refusal stop reasons, streams that
   die without terminal frames.
3. **Truth table (§4.3).** Find setting/event combinations that are ambiguous,
   contradictory, or unimplementable in a Tier A channel (Discord edit rate limits,
   message length caps, blockquote nesting).
4. **Idempotency/ordering (§7.3).** Reconnect, replay, out-of-order delivery with
   `dropIfSlow:true`, and crash-mid-draft scenarios.
5. **Privacy/security.** Ways raw thinking or redacted content leaks to a channel that
   didn't opt in; ways the archive tap could capture secrets that today get redacted.
6. **Coherence with the base contract.** Places SPEC.md silently contradicts
   agent-event-io-contract-f92c1bf.md rather than explicitly amending it.
7. **Mechanical answerability.** Try 5 queries of the form "provider X via transport Y,
   /reasoning A, /verbose B, channel tier T — what exactly renders?" If the spec can't
   answer one mechanically, that's a finding.
8. **Migration map (§9).** Items that are wrong, missing, or under-scoped relative to
   the evidence files' file:line claims.

Do not propose architecture changes for taste; only findings that show incorrect,
ambiguous, or unimplementable behavior. Cite evidence file + section for every claim.
