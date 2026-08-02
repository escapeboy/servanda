# Test vectors

Language-neutral JSON vectors for the Servanda protocol — the executable half of the
specification. An implementation claims conformance by passing these
(see [GOVERNANCE.md](../GOVERNANCE.md): *"implements Servanda" means "passes the conformance suite"*).

**These files are generated.** Do not edit them by hand — CI regenerates them and fails on any
byte of drift. To change a vector, change [`tools/vectors-gen/`](../tools/vectors-gen) and re-run
`npm run generate`.

```
canonicalization/jcs.json               16 cases    RFC 8785 canonical form + sha256
hashing/commitment-hash.json            14 cases    §3.2 five-field commitment_hash
envelope/envelope-id.json               12 cases    §2 envelope `id` preimage — which members reach the digest
envelope/bounds.json                    19 cases    §2 bounds, each with a case on both sides — M-19
signatures/signatures.json               5 cases    Ed25519 over sha256(JCS(obj sans sig))
derivation/persona-keys.json             5 personas BIP-39 → SLIP-0010 m/7391'/{i}'
transitions/valid.json                   9 cases    sequences a node MUST accept
transitions/invalid.json                25 cases    sequences a node MUST reject (M-14)
addressing/inbox-records.json            4 cases    §6.7 inbox records; hub-signed record rejected (M-17)
addressing/oob-bootstrap.json            2 cases    §6.7 URL/QR bootstrap payload, encode→decode→verify
recovery/proof-of-possession.json        6 cases    §6.6 a bare published rotation is NOT a proof — #37
node-surface/actions.json               11 cases    §7 advertised acts per (state, viewer role) — M-20
node-surface/act-tool.json              17 cases    §7 `act` calls: accepted, or refused with a reason
node-surface/brief-slots.json            7 cases    §7 `brief` slot shape; a copy-bearing slot is rejected — M-21
node-surface/verification-levels.json   13 cases    §1.6 ladder, name gating and `counterparty.origin` — M-12
schema/*.schema.json                                JSON Schemas, validated in CI
                                       165 cases total, across 15 families
```

## How to consume them

Every file carries `protocol_version`, `spec_reference` and a per-case `description`. No case
requires reading the generator to understand.

- **canonicalization** — `input` is raw JSON *text* (member order and number spelling preserved on
  purpose). Parse it, canonicalize, compare to `canonical` byte for byte; `sha256` is over the
  UTF-8 bytes of `canonical`.
- **hashing** — recompute `sha256(domain_tag.tag || 0x00 || JCS(subset))` over the five fields named
  in `hashed_fields`. `hash_preimage_hex` is the complete preimage as octets, tag and separator
  included, so the domain tag is checkable without reconstructing it. Cases with
  `same_hash_as_base: true` must produce a hash *identical* to `base_commitment_hash`; the rest must
  differ.
- **envelope/envelope-id** — remove `id`, canonicalize, and recompute
  `sha256(domain_tag.tag || 0x00 || JCS(envelope sans id))`. Cases with `same_id_as_base: false`
  prove the member reaches the digest. `id_removal` is the one case that cannot be written as a
  patch: an envelope that already carries `id` must hash to `base_id` once `id` is taken out.
  `determinism_scope` lists every member of the preimage — read it against §2's sentence about two
  nodes computing the same id, which names neither `persona` nor the observing node's own
  `received_at` ([#36](../../../issues/36)).
- **envelope/bounds** — M-19. Each case names the `bound` it sits on, its `measured` value in that
  bound's own unit, and whether it is `within_bounds`. A node MUST reject an envelope outside any
  bound rather than canonicalize it. `clipping.scalar_boundary_example` is a truncation that would
  split a 3-octet scalar if taken at the bound exactly: the clipped value must fall back to the
  scalar boundary and contain no code point absent from the source.
- **recovery/proof-of-possession** — §6.6, and the family that exists because of a hole. Feed each
  `request` to your responder and compare both the verdict and the reason. `bare-rotation-is-not-a-proof`
  is the one that matters: a genuine, verifying, PUBLISHED rotation and no challenge signature. v0.1
  answered it, which handed the edges and chains of two identities to anyone who had watched a
  rotation go by. A responder that accepts it is not merely lenient; it is the v0.1 defect.
- **signatures** — recompute `sha256_preimage` from `unsigned_object`, then verify `signature`
  against `signer.persona_id` (the public key). The `sig` field is excluded from its own preimage.
- **derivation** — derive from `mnemonic` and check every field, including `chain_code`.
- **transitions** — feed `assertions` to your verifier in order against `edge`. Each
  `expected_outcomes[i]` states whether that assertion is accepted and, if not, why.
  `expected_final_state` is the state after the whole chain.
- **addressing/inbox-records** — verify each `record` against the key named in its own `persona`
  field (§1.2: the persona_id *is* the public key). `known_keys` exists only so a verifier can
  report *which* other key signed a rejected record; a verifier without it still rejects, as
  `invalid-signature`. `hub_queue_ttl` is a fixture constant, not a test — see below.
- **addressing/oob-bootstrap** — base64url-decode the URL fragment, parse, and verify the
  signature against `sender.persona_id` using nothing else. `decoded_equals_original` and
  `edge_equals_original` are the round-trip assertions.
- **node-surface/actions** — derive the effective state from `edge` + `assertions` (the transitions
  verifier does this), then produce the `actions` array your node would return to `viewer`.
  It must equal `expected_actions` exactly, order included, and must contain **none** of
  `must_not_advertise`. `window_elapsed` is an input, not a clock read.
- **node-surface/act-tool** — make the `act` call in `call.input` as `call.caller` against that
  edge and state. `expected.accepted` and `expected.rejection_reason` are the contract;
  `expected.asserts` is the assertion state the node signs when it accepts.
- **node-surface/brief-slots** — judge one `slot` against the rule, and compare your judgement to
  `expected`. A slot may carry only the members in `slot_members`; a `primary_action` may carry only
  `act`, `tool` and `args`; the act must be in the vocabulary and its tool must match
  `act_tool_bindings`; and `tool: null` means `args` is empty. **Do not read `expected.valid` and
  agree with it** — that proves only that JSON parses.
- **node-surface/verification-levels** — grade `evidence` to a level and a display name.
  `level_rank` is the total order; `expected.display_name` is `null` at every level below `2`,
  including cases where a name was available.

> ⚠️ **`derivation/persona-keys.json` contains private keys.** They derive from published BIP-39
> test mnemonics (all-zero and all-`0x7f` entropy) and are public knowledge. Never use them for
> anything real.

## The invalid transition vectors are the point

§4.3 says *"Any assertion violating this table is invalid and MUST be discarded"*, and M-14
restates it. A verifier that accepts a `confirmed` assertion signed by the owner rather than the
counterparty has silently discarded the entire confirm-first guarantee — but it will still pass
every positive test. The 19 negative cases exist so that failure is loud. They include:

- owner self-confirming their own proposal (M-2), and a non-party signing (M-3)
- an assertion attributed to `by: <counterparty>` but signed with the owner's key
- closure by the wrong party, and closure with a null `evidence_hash`
- release asserted by the owner instead of `owed_to`
- expiry on a null `due`, and expiry before `due`
- an owner recording tacit acceptance *before* the acceptance window elapsed
- supersession double-signed by one party instead of both

## The addressing negatives say the same thing about §6.7

`addressing/inbox-records.json` carries one case that matters more than the other three: an inbox
record naming Alice as its `persona`, listing a hub she never chose, and signed by a **hub's** key.
§6.7 — *"Only the persona key may change its own hubs (a hub cannot 'move' its users)"* — and M-17
make it invalid. Accepting it would let any hub silently redirect another hub's users, which is
edge forgery moved from the ledger to the address book. The check that refuses it is one line and
needs no registry, because the persona_id is the verifying key.

`addressing/oob-bootstrap.json` pairs the round-trip with a payload whose `owed_to` was swapped
while keeping the original signature. It base64url-decodes and JSON-parses perfectly — neither
says anything about authenticity — and MUST fail verification. A courtesy renderer (§6.7, M-18)
that skips that check is a phishing surface rather than a renderer: a signed payload arriving over
an untrusted channel proves who signed it, never that the channel or the rendering page is
trustworthy.

**No time-travel test for hub TTL.** §6.7 fixes the hub queue TTL at 30 days and the inbox-record
lifetime at the same 30 days, refreshed at half-life; the constant is recorded in `hub_queue_ttl`
and never asserted against a clock. Generation is clockless by rule, and TTL expiry is not a
correctness boundary anyway — §6.7 makes a lost queued message harmless, because reconciliation
(§6.4), not delivery, is the guarantee.

## The node-surface negatives are about what a person is offered

`node-surface/actions.json` pins the `actions` array a node returns for a given edge, chain and
viewer, and `must_not_advertise` names every act it must **not** offer. The sharp cases:

- `release` offered to the **owner**. §4.3 gives `release` to `owed_to` alone. A node that offers it
  to the owner is inviting an assertion the table discards — and the person believes they forgave a
  debt that is still open against them.
- `done` offered to the owner while the acceptance window is still running. The two
  `pending-acceptance-owner-*` cases differ only in `window_elapsed`, which is why that flag is an
  input rather than a clock read.
- anything at all offered to a non-party, or on a terminal edge. Both must be an empty array.

`node-surface/act-tool.json` is the other half: acts §7 declares unbound (`supersede`, `delegate`,
`ping`, and the `confirm`-bound `dismiss`) MUST be refused by `act` rather than served something
that looks like it worked. A node that quietly maps `release` onto a local dismissal produces
exactly the failure M-20 exists to prevent — a control that reports success while the counterparty
is never told.

`node-surface/brief-slots.json` closes the half of M-21 that was open longest. `actions.json` pinned
`open_loops`, and nothing pinned `brief` — so an implementation could ship slots carrying
node-supplied button text and pass the entire suite. The load-bearing case is
`invalid-label-on-the-primary-action`: a `label` is a node telling a client what to write, which is
what M-21 forbids and the exact shape that was reported against `brief`. The rest of the negatives
close the ways the same thing arrives wearing a different key — copy one level up on the slot, an
act outside the shared vocabulary, an unbound act naming a tool, arguments beside a null tool.

`headline` is the deliberate exception, and it is worth understanding rather than memorising: a
person's own recorded words are CONTENT and travel verbatim. What M-21 forbids is a node writing
the words a client puts on its own controls.

`node-surface/verification-levels.json` pins the M-12 ladder: the total order `0 < 1 < ext < 2 < 3`,
the case where a binding proof and an attestation are both present (`2` wins — self-assertion does
not outrank a third party staking its key), and the negatives where a display name **is** available
in the surrounding data and MUST NOT be emitted because the achieved level does not carry it.

## Interpretations, and what became normative

Most of what this file used to list as generator guesses is now spec text. The v0.1-pre resolutions
took each of them as a decision, so the table below records **what the vectors encode and where the
spec now says it** — not what the generator assumed in the absence of an answer.

| # | Question | Resolution, now normative |
|---|---|---|
| 1 | `\|\|` in the `edge_id` preimage | §4.1: octet concatenation, no separator, no length prefix; each value contributes its own UTF-8 encoding. Worked byte-offset example in §4.1 |
| 2 | §4.1's preimage omits `closure_policy`, `due`, `blocked_by`, `supersedes` | §4.1: the preimage stays as it is; a node binds an `edge_id` to the **first** edge body it accepts and rejects any later body under that id whose other members differ |
| 3 | §4.3 `confirmed → open` marked "(implicit)" | §4.3: `open` is never assertable. `confirmed` ≡ `open` as one effective state; an explicit `open` assertion is discarded under M-14 |
| 4 | §4.4's three acts, §4.3's one row | §4.3: four rows over a **computed** `pending-acceptance`, which is never an assertion's `state` |
| 5 | `acceptance_window` "required iff on-acceptance; default P5D" | §4.1: non-null iff `on-acceptance`, null otherwise, **no default**. An `on-acceptance` edge with a null window is malformed and accepts no assertions |
| 6 | §4.3 `disputed → closed` "both parties" | §4.4: v0 defines no arbitration. `disputed` exits only by both parties asserting `closed`, or by supersession |
| 7 | §4.5 supersession must reference the successor, but no field carries it | §4.5: the assertions bind the **fact** of supersession, not the successor's identity. No `supersedes_with` field was added; a verifier MUST NOT report the successor link as agreed |
| 8 | Signing preimage stated across two sections | §0: `sha256(JCS(object minus every `sig`/`sig_*` member))`. Signing preimages are **not** domain-tagged |
| 10 | §6.7 `hubs` array order | §6.7: the declared order **is** the priority order; a sender MUST NOT reorder it |
| 11 | Identifier preimages had no type tag | §0: every identifier preimage begins with an ASCII domain tag and one `0x00`. This changed every `commitment_hash` and every `edge_id` — see the change note in §0 |

Two things remain interpretations, and are still marked as such at the code sites:

| # | Spec gap | What the vectors assume |
|---|---|---|
| 9 | §6.7 says the out-of-band `propose` travels "in a URL/QR" but fixes no serialization | `base64url(JCS(message))`, unpadded, carried in the URL **fragment** so the payload never reaches a courtesy renderer's server |
| 12 | §7 `act` rejection reasons are not enumerated in the spec | The reason strings in `node-surface/act-tool.json` are the suite's names for refusals §7 requires but does not name |

## Regenerating

```bash
cd tools/vectors-gen
npm ci
npm run generate   # rewrite ../../vectors
npm test           # selfcheck (drift + crypto + verifier replay) then schema validation
```

`npm test` is what CI runs. It re-derives every key, re-canonicalizes every case, re-verifies every
signature, replays every transition chain, and diffs the result against what is committed.
Generation is deterministic: no clock, no randomness, no network.
