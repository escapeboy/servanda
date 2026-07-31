# Design — a dedicated X25519 key per persona

Answers the five open questions in `docs/requirements-persona-dh-key.md`. Read that first; this
document only decides.

## The shape, and why it is smaller than it looked

Two facts, both verified rather than assumed, collapse most of the difficulty:

1. **Only the hub transport seals.** `git-transport.ts` contains no call to `sealToPersona` —
   §6.1 says git confidentiality *is* repository access. The single caller is `hub-transport.ts`.
2. **Hub delivery already requires a published, signed §6.7 inbox record**, because that is where
   a sender learns which hubs to try, in what order.

So the DH key needs to be known **exactly where a signed record is already required**, and nowhere
else. That is the whole design.

## Q1 — What carries the key? The §6.7 inbox record.

`{ v, type:"inbox", persona, hubs, issued_at, sig }` gains `dh_key`.

- **It is already authenticated.** The record is self-signed and M-17 already says only the persona
  key may alter it, with a named test and four conformance vectors. R3 needs no new machinery: a
  DH key that arrives in a record signed by the persona it names is bound to that persona by the
  rule that already exists.
- **It adds no publication surface (N2).** A persona reachable over a hub must already publish this
  record. Adding a field to a record an observer could already see and compare creates no new
  correlation handle. A design that invented a second published statement would have.
- **R4 falls out.** No hub means no sealing means no DH key is needed at all. A persona that
  federates over git, or that never federates (M-10), publishes nothing and derives nothing it
  does not use.

Rejected: a §1.3 attestation (org-issued; a persona without an org has none), and a new self-signed
statement type (a second published record is exactly the new correlation surface N2 warns about).

## Q2 — Rotation: at the record's own cadence, for free

§6.7 already expires an inbox record 30 days from `issued_at` and asks for republication at
half-life. A `dh_key` inside it inherits that: a persona that rotates its DH key publishes a new
record, and senders stop using the old key when the old record expires, by machinery that already
exists and is already tested.

The signing key's own rotation (§1.7) is unchanged and independent. A persona MAY rotate its DH key
without rotating its identity, which is the right way round — the identity is the expensive one.

## Q3 — Hard break

No dual support. Accepting both constructions means a code path that decides which to use, and R5
forbids exactly the fallback such a path invites. The project's pattern is to break cleanly and
disclose; 0.2.0-pre already does not migrate from 0.1.0-pre.

## Q4 — The OOB bootstrap is untouched

§6.7 first contact is a *signed* propose in a URL, not an encrypted one — `bootstrap.ts` performs
no sealing. Confirmed by reading, and it is what makes first contact possible at all: you cannot
seal to someone whose key you have not yet learned.

## Q5 — Where the spec changes land

§1.2 and §1.7 (the derivation path), §6.3 (the key schedule and what it seals to), §6.7 (the record
shape), §9.3 (drop the birational map from the transport line). Filed upstream.

## Derivation

`m/7391'/{personaIndex}'/1'` — a hardened child of the persona path.

Hardened, so the DH public key reveals nothing about its parent or its siblings: two personas from
one seed stay unlinkable to anyone without the seed (§1.2, N2). `/1'` leaves `/0'` free should a
persona ever need a second subkey class.

## Key schedule

The recipient's X25519 key is now a real key rather than a mapped one, so `recipientX` stops being
derived from `persona_id`. The `info` binding stays and matters more, not less: it is what ties the
ciphertext to the *identity* rather than to whichever key that identity currently advertises.

```
key = HKDF-SHA256(ikm  = X25519(esk, dh_key),
                  salt = epk ‖ dh_key,
                  info = "servanda/0.1 blind-courier v2" ‖ 0x00 ‖ recipient_persona_id,
                  L    = 32)
```

`v2`, because the schedule changed. The AAD binding of the outer envelope fields is unchanged.

## R5 — failing closed

`sealToPersona` takes the recipient's DH key as an argument and cannot compute one. There is no
code path from a `persona_id` to a sealing key any more, so the fallback R5 forbids is not
something to remember to avoid — it is unreachable.

`HubClient` gains an injected resolver, in the style of `FetchLike` and the IMAP client: given a
persona, return its verified DH key or null. Null refuses the send.

## What this costs

Every 0.2.0-pre sealed payload and every queued hub message becomes unopenable, and every vault
gains a key it did not have. The identity, the edges and the assertion chains are untouched —
`persona_id` is still the Ed25519 public key, and nothing about M-1, M-2 or the transition table
moves.

## Last Updated

2026-07-31
