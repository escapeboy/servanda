# @servanda/identity

The verification logic §1 describes. Everything here is a pure function over evidence with its
resolvers injected — the package cannot reach the network, and gate GG proves it.

## The ladder (§1.6)

```
0 unconfirmed → 1 continuity → 2 attested → 3 domain-verified → ext external-proof
```

Evidence in, level out. This is what makes **M-12** enforceable: a client must display the level
and must never render a display name above its evidence. Name and level come from one call, so
there is no way to obtain the name without the level that qualifies it.

Downgrades are as important as upgrades and are tested as such: an expired attestation, an anchor
that will not resolve, a key revoked before it signed.

## Attestation and the revocation boundary (§1.3)

`claims.display_name` and `handle` are **the org's assertions, not protocol truths**. Verification
checks the org's signature and the expiry, then applies the offboarding rule that actually matters:

> Edges signed **after** `revoked_at` are not org-attested. Edges signed **before** remain valid.

Someone leaving a company does not unmake the promises they kept while they were there.

## Domain anchor (§1.5)

`https://{domain}/.well-known/servanda.json` and/or a `_servanda.{domain}` TXT record, resolved
through an **injected** transport and cached to the resource's TTL with an injected clock.

This is what carries the email-shaped intuition — "from @studio.bg means from the studio" — which
is the whole reason a cross-org counterparty believes an edge without knowing what an attestation
chain is.

## Rotation (§1.7)

The object with the largest blast radius in the protocol: it transfers continuity over **every open
edge** of the old persona. So the forgeries are tested first — a rotation nobody signed, or signed
only by the new key, transfers nothing.

`Rotation` accepts both encodings and requires the old key's signature; §1.7's `sig_old`/`sig_new`
shape has no defined signing preimage under the universal signing rule, which is filed upstream as
issue #17. This package follows the vectors and never invents a preimage rule.

## Recovery (ADR-0014)

Two seedless paths: org re-attestation of a fresh persona (level 2), and rotation published over an
existing external binding-proof channel.

There is no third, and the absence is asserted rather than papered over: **a persona with no seed,
no org and no external proof is unrecoverable by design.** Inventing a fallback there would be
inventing a backdoor.
