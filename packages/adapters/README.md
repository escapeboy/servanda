# @servanda/adapters

Verification — the mechanism §4.4 and M-8 presupposed and nothing implemented.

```ts
VerificationAdapter: (commitment, context) → EvidenceBundle | NotVerifiable
```

## Why this exists

Two sentences in the spec assume a verification adapter:

- §4.4 — an `on-evidence` closure is "a `closed` assertion by the owner with non-null
  `evidence_hash` (**hash of the verification adapter's evidence bundle**)".
- M-8 — "Unverifiable edges (**no adapter**, or invalid collective) MUST NOT auto-escalate."

Before this package, `evidence_hash` was an opaque hash nobody produced and "unverifiable" had no
mechanism behind it. This is the part that decides whether a promise was actually kept.

## What an adapter may and may not do

An adapter **observes and reports**. It never asserts, never signs, never closes an edge.
Closure is the owner's signed act (§4.4), and M-13 keeps automation out of the party role — an
adapter that could close an edge would be an agent acting *as* a party rather than under one.

Bundles hash reproducibly: `sha256(JCS(bundle))` is exactly the `evidence_hash` an assertion
carries, and the same observation yields the same hash on any machine.

Registry, hardcoded and small like the executor registry: **ci**, **git**, **file**. Each declares
what it can observe and refuses everything else.

## NotVerifiable is a result, not an error

An edge no adapter can speak to is unverifiable, and M-8 then forbids auto-escalation. That path is
deliberately the easy one: **a caller that ignores the distinction gets the safe behaviour**, a
null hash and an edge that stays open, rather than a silent close.

The M-8 tests carry their own control — an overdue, *verifiable* on-evidence edge **does** escalate
— so "unverifiable never escalates" cannot pass merely because nothing ever escalates.

## Collective edges (§4.7, M-9)

A collective edge whose `fulfillment` neither covers the work through `children` nor names a
`coordinator` is unverifiable, and the adapter layer says so before observing anything. Tested both
ways: a covering decomposition or a named coordinator makes it verifiable again.
