# Crypto review packet — upstream servanda-protocol#7

**This packet does not discharge the gate.** `spec/00-overview.md` says of the cryptographic
review: *"This gate cannot be discharged by the editors."* What follows is a pre-review by an
editor-side reader: it narrows what an external cryptographer has to look at, and states what was
checked empirically versus what was only read. Treat every "clean" below as *no defect found by
this method*, never as *proved sound*.

Scope: the two items #7 names — the Ed25519 → X25519 birational map (§6.3) and the Argon2id
parameters (§1.7, §9.3).

## What the construction actually is

`packages/crypto/src/transport.ts`, ~55 lines. Ephemeral-static X25519 to the recipient's
**signing** key, HKDF to a symmetric key, XChaCha20-Poly1305:

```
recipientX = edwardsToMontgomeryPub(recipient_persona_id)     // Ed25519 pk -> Montgomery u
(esk, epk) = X25519.keygen()
shared     = X25519(esk, recipientX)
key        = HKDF-SHA256(ikm = shared,
                         salt = epk ‖ recipientX,
                         info = "servanda/0.1 blind-courier v0",
                         L = 32)
sealed     = XChaCha20-Poly1305(key, random 24-byte nonce).encrypt(JCS(wire message))
```

The recipient converts its Ed25519 **private** key with `edwardsToMontgomeryPriv` and repeats.

Vault side, `packages/crypto/src/content-key.ts`: a random 256-bit content key, wrapped
independently per device key and per passphrase; the passphrase KEK is
`Argon2id(m = 65536 KiB, t = 3, p = 1, dkLen = 32)` over a fresh 16-byte random salt, with the
salt and parameters stored beside the wrap.

## Checked empirically — clean

Run against `@noble/curves` as vendored. Method matters here: these were exercised, not read.

| # | Property | Result |
|---|---|---|
| 1 | `edwardsToMontgomeryPriv(seed)` performs SHA-512 + clamping, not raw-seed reuse | **clean** — `X25519.pk(toMontgomeryPriv(seed))` equals `toMontgomeryPub(Ed25519.pk(seed))` |
| 2 | Low-order / small-subgroup public inputs | **clean** — all five classical low-order encodings throw `invalid private or public key received`; no all-zero shared secret is ever returned |
| 3 | Non-curve public input | **clean** — rejected at point decompression |
| 4 | HKDF binds the transcript | **clean** — `salt = epk ‖ pkR` and a versioned `info`; this is essentially DHKEM's `kem_context`, not a raw DH output used as a key |

(1) is the finding that matters most, because getting it wrong is catastrophic and silent-ish:
using the 32-byte seed directly as an X25519 scalar is the classic error in this conversion. It is
not present.

## Findings for the reviewer

### F-1 — The key-reuse question itself is not settled by inspection *(the actual subject of #7)*

One key pair both **signs** (Ed25519, with `sig` over `SHA-256(JCS(object))`) and performs **DH**
(X25519). Joint security of a signature scheme and a KEM over shared key material is a studied
problem, not a self-evident one. The reviewer should start from Thormarker, *On using the same key
pair for Ed25519 and an X25519 based KEM* (IACR ePrint 2021/509), and from the joint-security
literature on signature+KEM composition.

What this pre-review cannot establish, and what the reviewer must: whether **this** construction
falls inside the analysed cases — ephemeral-static DH against a long-term *signing* key, with an
HKDF whose salt binds `epk ‖ pkR`, where the same key also signs attacker-chosen messages
(§4.2 assertions are attacker-influenceable in content).

I record low confidence here deliberately. It is the one item where reading the code cannot
substitute for a proof.

### F-2 — "Encrypted to the recipient persona key" is stronger than what the map delivers

The Ed25519 → Montgomery public map is **2-to-1**. `u = (1 + y)/(1 − y)` depends only on the
y-coordinate, and a compressed Ed25519 public key is `y` plus a sign bit. Verified: `P` and `−P`
are two **distinct** 32-byte persona_ids that map to the **same** X25519 key, so a ciphertext
sealed "to persona X" is sealed to a y-coordinate that two persona_ids share.

Practical exploitability looks limited — holding the sibling requires a seed whose clamped scalar
is `−s`, which an attacker cannot choose, and an unsignable persona is inert under M-1/M-2. But
the §6.3 sentence claims identity binding the construction does not provide. Either the sentence
should be narrowed, or the sealed payload should bind the full `persona_id` (it is already
available: fold it into `info`, which costs nothing).

### F-3 — No sender authentication below the signature, and no recipient binding above it

The KEM is anonymous by design (§6.3: the hub must not learn the sender). Authentication comes
entirely from the Ed25519 signature *inside* the ciphertext. But `WireMessage` is
`{v, type, payload, sender, sent_at, sig}` — verified: **there is no recipient field**, so the
signature does not bind who the message was for.

Consequence: any recipient can re-seal a validly-signed message to a third party. What prevents
harm today is per-message-type application logic, checked and confirmed present for the
edge-scoped types (`propose` rejects `edge.owed_to !== self`; `assert` requires `isParty` for both
holder and sender; responders filter through `mayServeEdge`). `recon_request` and
`recover_request` carry no such binding — they are surfaced as `{from: message.sender}` and
answered — and their safety rests on the *responder* filtering by party rather than on the request
being addressed to anyone.

The invariant is therefore "every message type must independently re-derive its own
authorization", which holds now and is easy to break with a new type. HPKE Auth mode, or simply a
`recipient` field inside the signed preimage, would make it structural. Worth the reviewer's
judgement on whether that is a finding or an accepted design.

### F-4 — Nothing is authenticated outside the ciphertext, and there is no replay window

No AAD is passed to any AEAD call in the codebase. The hub envelope's `recipient` and `sent_at`
sit outside the sealed blob, so a hub may rewrite `sent_at` at will. Verified: nothing validates
`sent_at` for freshness anywhere in `packages/federation`; the anti-spam budget is per-sender rate
limiting, not replay detection.

Whether this matters is a protocol question — §6.7 already declares delivery unreliable and makes
reconciliation the guarantee, so replays are expected and consumers are required to be idempotent.
Say so explicitly in §6.3 rather than leaving it to be inferred.

### F-5 — Device keys are used directly as AEAD keys

`wrapForDevice` passes `fromHex(deviceKeyHex)` straight to XChaCha20-Poly1305 as a key: no KDF, no
domain separation, no length or entropy check. Sound iff every caller supplies 32 uniformly random
bytes, which nothing enforces and no type expresses. One HKDF with a distinct `info` would remove
the assumption.

### F-6 — Argon2id `p = 1` where RFC 9106's second recommended option says `p = 4`

`m = 64 MiB, t = 3, p = 1`. RFC 9106's second recommended option is `t = 3, m = 64 MiB, p = 4`;
this sits above the common OWASP floor (`m = 19 MiB, t = 2, p = 1`). Lowering `p` is not weakening
in the standard model — `p` models the attacker's parallelism — but the spec calls these values a
*minimum*, and a downstream implementer may read `p` as tunable downward alongside it. State the
three values as a triple that moves together, and say which of them, if any, an implementation may
raise.

Minor, same area: `unwrapWithPassphrase` runs a full Argon2id per candidate slot, so unlock cost
scales with the number of passphrase wraps.

### F-7 — Not a review item: the spec does not state the parameters

#7 notes the Argon2id parameters "are not stated anywhere in this repository as concrete values" —
that is about the **spec** repo. In the implementation they are concrete and exported
(`ARGON2ID_PARAMS`) and stored per wrap for agility. This half is a documentation fix upstream,
not something a cryptographer needs to rule on.

## Two things a reviewer should be handed alongside this

1. **`packages/crypto/src/transport.ts` and `content-key.ts` in full** — together under 230 lines,
   and the whole of what #7 covers.
2. **The threat model it is meant to hold against** — `spec/09-threat-model.md`, in particular that
   a hub is assumed hostile-but-honest-ish (blind courier, M-11) and that plaintext never appears
   in wire objects (M-7).

## Suggested order

F-1 first: it is the only item that can invalidate the design rather than the wording, and every
other finding is cheap to fix once it is settled. F-2 and F-5 are one-line changes if accepted.
F-3 is the one that deserves argument rather than a patch.

## Last Updated

2026-07-31
