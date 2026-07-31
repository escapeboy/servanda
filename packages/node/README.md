# @servanda/node

L1 — the edge state machine — plus the §7 MCP surface that every client speaks to.

## The transition table is the constitution's enforcement point

```ts
const result = verifyAssertionChain(edge, assertions);
// → { outcomes: [{ index, accepted, rejection_reason? }], finalState }
```

§4.3: *"Any assertion violating this table is invalid and MUST be discarded."* This function is
where that becomes true. It reproduces all 26 conformance vectors — 7 chains a node must accept and
19 it must reject — with the exact `rejection_reason` strings the suite asserts on.

The 19 negative cases matter more than the positive ones. A verifier that accepts a `confirmed`
assertion signed by the owner rather than the counterparty has silently discarded the entire
confirm-first guarantee, and would still pass every positive test. Among the cases it must reject:

- the owner self-confirming their own proposal (M-2)
- an assertion attributed to the counterparty but signed with the owner's key
- release asserted by the owner instead of `owed_to` — release is *forgiveness*, and only the
  person owed can forgive
- an owner recording tacit acceptance before the acceptance window has elapsed
- an explicit `open` assertion (§4.3 marks that transition implicit)

Effective state folds `confirmed` into `open` and adds `pending-acceptance` to model the §4.4
window, which §4.3 has no row for. Both are interpretations, documented upstream (issues #12, #13),
not invented silently.

## The six tools (§7)

```ts
const node = new ServandaNode({ vault, activePersona, now });
node.commit({ intent, owed_to, due, propose });
node.expect({ expect, from, context });
node.confirm({ id, decision, edit });
node.openLoops({ view, persona, limit });
node.brief({ persona });
```

Exposed over MCP stdio via `mcp/stdio.js`. Clients — assistants, the web ledger, the TUI, the email
brief — are interchangeable above this contract; that is the point of having one.

`commit` throws `M1Violation` if handed an owner that is not the caller's persona. You cannot record
someone else's promise as theirs; the correct object is `expect`. `assertNoForeignOwner` is exported
so the rule is testable in isolation.

## What the node will not do

- **M-11 — no reputation.** It does not compute, store or serve cross-party fulfillment statistics.
  `localPairwiseHistory` is deliberately local and pairwise; `M11Violation` exists to make the
  boundary explicit rather than implicit.
- **M-8 — no auto-escalation of unverifiable edges.** An edge with no verification adapter, or an
  invalid collective decomposition, is marked unverifiable and stays quiet. Escalating something you
  cannot verify is how a notary becomes a nag.
- **Undated commitments never time-escalate** (§3.1). `due: null` is expected to be the majority
  case; those rank by age × blocking, never by an invented deadline.

## Ranking

`brief` orders by the attention market — `cost_of_delay × confidence × people_blocked` — and never
by manual sort. With `persona: null` the ordering is cross-persona, which is the sole exception
§5.3 allows; each slot's *content* still originates from exactly one persona's pipeline (M-5).
