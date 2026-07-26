# ADR-0016 — A rule gets one home, even when that costs a package

**Status:** Accepted · 2026-07-26
**Scope:** This repository (the reference implementation), not the protocol.

## Context

A structural pass over the graph found three rules implemented more than once, each in packages
that do not depend on one another:

- **Collective decomposition (§4.7 / M-9)** — byte-identical in `@servanda/node` and
  `@servanda/adapters`. Both packages decide verifiability; neither depends on the other. It was
  kept honest by an agreement test (`adapters/test/musts/M-09.test.ts`) asserting the two answer
  identically across a table of edges.
- **The §2 envelope boundary** — three copies, one per connector, carrying the payload bounds,
  the undefined-stripping, and `sealEnvelope`. The in-code rationale was explicit: the connector
  packages own no shared package, and making one connector depend on another would put an
  unrelated package on the critical path. "Twenty lines is cheaper."
- **`actionsEl`** — restated in `@servanda/gestures` alongside a comment noting it was "the same
  ordering law the app's cards follow, for the same reason."

Each duplication was deliberate and each had a defensible local argument. The question was
whether those arguments survive at the level of the whole repository.

## Decision

**A rule that the protocol makes normative gets exactly one implementation, and the cost of
giving it a home is paid rather than avoided.**

Concretely:

1. Collective decomposition moves to `@servanda/types`, beside the `Edge` schema it is a property
   of. Both packages already depend on `types`, and the source comment had already recommended
   this. The package-local names survive as aliases, so no public surface changed.
2. A new `@servanda/envelope` holds the shared envelope boundary. The original objection was to a
   dependency *between connectors* — a neutral package is not that. `sealEnvelope` computes the
   envelope `id` by hashing, so two copies that drifted would not merely duplicate code: they
   would give one observation two identities, which §2 does not permit.
3. `actionsEl` is typed against `RenderableAction` — the narrow shape it actually reads (`id`,
   `label`, `primary`) — which both the app's `ActionView` and a gesture card's action satisfy.
   One renderer, one ordering law.

**What stays duplicated, deliberately:**

- **`label`**, per connector. Mail can deliver a bidi override inside a display name, so the mail
  connector strips Unicode *format* characters as well as controls; the other sources do not get
  that rule. This is a genuine difference in threat, and keeping it local makes it a visible
  decision rather than an invisible divergence between near-identical files.
- **`check()` in the eight `prove-no-network` scripts.** Those scripts run under plain `node` with
  nothing loaded, which is the point of them. Giving them a shared module would hand a dependency
  to the very scripts whose job is to prove there isn't one.

## Consequences

- An agreement test between two copies is a *weaker* guarantee than one implementation, and it is
  worth saying why: it proves the copies agree on the rows someone thought to write down. One
  implementation cannot disagree with itself on a row nobody imagined. The M-09 test is kept, with
  its purpose restated — it now fails if either package starts answering from a local copy again.
- Package count is not a cost worth optimising against in a monorepo whose packages are already
  drawn along protocol seams. `@servanda/envelope` is small on purpose.
- **A hand-written list of packages is a coverage surface.** `connectors-email`'s no-network audit
  enumerates the dists it scans; adding a dependency without adding it to that list left a shipped
  module unscanned while the check still reported the whole graph clean (26 modules scanned before,
  27 after). Any such list widened by a new dependency must be widened by hand, and the file now
  says so.

## Alternatives considered

- **Keep the mirrors, add agreement tests to the two that lacked them.** This is the repository's
  existing idiom and it would have been cheaper. Rejected because it polices duplication instead of
  removing it, and because the envelope case is not symmetric with the collective case: an
  agreement test on `sealEnvelope` would have to enumerate inputs, and the failure it guards
  against — divergent envelope ids — is exactly the kind that shows up on an input nobody listed.
- **Hoist the envelope helpers into `@servanda/types`.** Rejected: `sealEnvelope` needs
  `hashCanonical`, and `types` depends on nothing but zod. Making the schema package depend on
  crypto to avoid creating a small package is the worse trade.
