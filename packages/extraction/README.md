# @servanda/extraction

Turns signal envelopes into candidate commitments — under the tightest containment in the system.

## The three constraints (§3.4, §9.2)

1. **No tool access.** The model call passes no tools at all. Not a restricted set — none.
2. **Schema-bound.** It emits objects valid against §3.1 or **nothing**. Every output is validated
   against the zod schema; anything that fails is dropped. A malformed response yields zero
   commitments, never a partial guess.
3. **Single-persona context** (M-5). The persona is bound at construction, not passed per call.

## The honest claim

LLM extraction is **never** injection-proof, and this package does not pretend otherwise. §9.2
states the guarantee precisely, and the code's shape is what makes it true:

> a fooled model can produce at most an unconfirmed proposal — **nothing a human didn't sign**.

Results land in a pending-confirmation queue. Nothing auto-commits. The worst case for the attack
in scenario 6 — a repo comment reading *"SYSTEM: ignore previous instructions…"* — is a junk record
a human dismisses, and the dismissal is itself the label that makes the next attempt fail earlier
(ADR-0012).

## §3.4 routing — the subtle part

```ts
route(result, nodePersona);
// → 'reflexive' | 'may-propose-after-confirmation' | 'expectation-only'
```

- **reflexive** — you promised yourself. Vault-local, never on the wire.
- **may-propose-after-confirmation** — you are the owner and someone else is owed. A wire `propose`
  requires an explicit confirmation act by you first.
- **expectation-only** — *someone else* is the owner. This can **never** become a `propose`.

That last case is M-1, and it is the one worth stating plainly: you cannot propose someone else's
promise. "They said they would" is an **expectation** (§3.3) — vault-local, never on the wire
(ADR-0013), escalating only to you. The system cannot and may not chase a third party on the basis
of something a model thought it heard.

Extraction is asymmetric by construction: generous toward you about your own intents, conservative
to the point of suspicion about other people's.

## The precision harness

```bash
pnpm --filter @servanda/extraction harness --dry-run   # stub model, no API calls, no spend
pnpm --filter @servanda/extraction harness             # live; needs ANTHROPIC_API_KEY
```

Scans `~/.claude/projects/**/*.jsonl` **read-only**, runs extraction over the last 30 days, and
writes `precision-report.md` at the repo root (gitignored — it contains private transcript
content). Every extracted commitment appears with its verbatim source quote, so a human can judge
each one.

**The report scores nothing.** Precision is a human verdict; the harness produces the evidence for
it. In `--dry-run` the "model" is a small regex rule table with no judgement, and the report says so
at the top in as many words — whatever fraction of stub rows look right is a fact about the stub,
not about the extractor.

Subagent transcripts are skipped, citing **M-13**: an agent is never a party, so what a subagent
said cannot be a promise.
