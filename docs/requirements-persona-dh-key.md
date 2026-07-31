# Requirements — a dedicated X25519 key per persona

**Status: requirements only.** No design, no schema, no code. The next step is a design pass;
this document exists so that pass has something to be measured against.

## Why

Upstream [#7](https://github.com/escapeboy/servanda-protocol/issues/7) is a gate on the v0.1
freeze and has two halves of very different cost. The expensive half — whether one key pair may
both sign (Ed25519) and perform key agreement (X25519) — cannot be settled by reading, and the
issue names its own way out: *"The alternative is a separate X25519 subkey derived from the same
SLIP-0010 path — more key management, no reuse question."*

**The goal is to make the question stop existing, not to answer it.** Standard primitives used in
standard ways need no novel analysis. External review remains wanted — as an improvement, no longer
as a gate.

Two things have changed since #7 was written and both help: §6.7 now defines a signed inbox record
(there is somewhere to put a public key that did not exist), and the birational map's 2-to-1
property has been confirmed empirically rather than suspected
(`docs/crypto-review-packet.md`, F-2).

## Functional requirements

**R1 — Deterministic, recoverable derivation.** A persona has an X25519 key pair derived from the
same BIP-39 seed via SLIP-0010, at a hardened path distinct from its signing key. The 24 words
alone MUST restore it, or ADR-0014's recovery story quietly loses a key.

**R2 — Identity is unchanged.** `persona_id` remains the Ed25519 public key. Nothing about M-1,
M-2, signatures, `edge_id` or the assertion chain moves. This is an encryption change only.

**R3 — The DH key is authenticated, never merely published.** A sender MUST verify that the DH key
it seals to is bound to the persona by a signature under that persona's Ed25519 key. An
unauthenticated DH key is a substitution attack with extra steps — precisely the shape of M-17,
one layer down.

**R4 — Reachability without a hub.** A persona MUST be sealable-to without having declared a hub.
§6.7's inbox record is the obvious carrier and is hub-shaped; a persona that federates over git
has no hubs and still needs to receive sealed payloads.

**R5 — Fail closed.** Where no authenticated DH key is available, sealing MUST refuse. It MUST NOT
fall back to the birational map, and MUST NOT send plaintext. A silent fallback would preserve
exactly the construction this change exists to remove.

**R6 — The break is stated and versioned.** Sealed payloads and any queued ciphertext from
0.2.0-pre become unopenable. The key-schedule label carries a version already
(`servanda/0.1 blind-courier v1`); the next one must move, and the CHANGELOG must say so before
the tag, not after.

## Non-functional requirements

**N1 — Solo use stays complete (M-10).** A node that never federates MUST NOT need to publish
anything, contact anyone, or hold a DH key it never uses. Derivation may be lazy; it may not be
networked.

**N2 — Personas stay unlinkable (§1.2).** *This is the sharp one.* Personas from one seed are
unlinkable to anyone without the seed. A DH key derived from that same seed MUST NOT create a
correlation handle — not through the derivation (a public key that leaks a shared parent), and not
through publication (two personas that must both publish to be reachable become two records an
observer can compare). Any design that makes reachability require publication has to answer this.

**N3 — A hub still learns nothing new (§6.3, M-11).** Whatever carries the DH key, a hub's view
must not widen. If the carrier is fetched from a hub, the fetch itself is a signal.

**N4 — The new construction is pinned by vectors.** The derivation path and the key schedule MUST
both be fixed by conformance vectors. Without that the change swaps one implementation-defined
construction for another — which is upstream
[#30](https://github.com/escapeboy/servanda-protocol/issues/30), not a fix for it.

## Acceptance criteria

1. §9.3 no longer names the birational map for transport encryption.
2. #7 narrows to its Argon2id half — and that half is a parameter judgement, not a research
   question. Two of its three sub-items are already answered by the implementation.
3. A named test proves sealing REFUSES when no authenticated DH key is present (R5), with a
   control proving the test can fail.
4. A recovery test restores a persona from the 24 words alone and opens a payload sealed to it
   before the restore (R1).
5. New vectors pin the derivation path and the key schedule (N4).
6. Gates and the M-suite stay green; no MUST loses a test.

## Open questions — for the user and for upstream

These change the design and none of them is mine to settle.

**Q1 — What carries the DH key?** The §6.7 inbox record is signed and already the addressing
surface, but it is defined around `hubs`. Options: extend it and allow an empty hub list; extend
the §1.3 attestation; define a new signed statement. Each has a different answer to N2.

**Q2 — Does the DH key rotate?** §1.7 rotation covers the signing key. Does the DH key rotate with
it, on its own schedule, or never? Rotation with a published carrier means republication, which is
an N2 question again.

**Q3 — Hard break or dual support?** Accepting both constructions for a window is friendlier and
keeps the old one alive — including in code paths that decide which to use, where R5's fallback
ban is easiest to violate. The project's own pattern has been to break cleanly and disclose.

**Q4 — Does this reach the OOB bootstrap?** §6.7 first contact is a *signed* propose in a URL, not
an encrypted one. It looks untouched; worth confirming rather than assuming.

**Q5 — Where does the spec change land?** §1.2, §1.7, §6.3, §9.3 and possibly §6.7. That is a
larger upstream PR than #28 was, and it is spec work before it is implementation work.

## What this document does not do

It does not choose a carrier, a derivation path, a wire format or a migration strategy. It does not
claim the change is small. It says what would have to be true for it to be correct.

## Last Updated

2026-07-31
