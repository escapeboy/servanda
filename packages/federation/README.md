# @servanda/federation

L2 — the layer that lets two nodes agree. Optional by design: L0–L1 are complete without it
(M-10), and nothing here may weaken them.

## Why it matters

Before this package existed, a cross-person edge could be created locally and never delivered.
**M-2 — the counterparty's signature is what makes a promise exist — was untestable between
machines.** Gate GF is the proof: propose → confirm → assert over a transport, both nodes
converging on one chain and one state, with networking denied.

## Transports (§6.1)

- **git** — messages as files under `servanda/{edge_id}/{seq}-{type}.json` in a shared repository;
  sync is fetch/push. Suits team scopes: self-hosted, offline-tolerant, and auditable by anyone who
  can read a git log.
- **hub** — an HTTPS relay. `POST /servanda/v0/deliver`, `GET /servanda/v0/inbox?persona=…`.

## The hub is blind (§6.3)

Hub-bound payloads are sealed to the recipient persona key. A conforming hub sees **recipient,
ciphertext, timestamps — and nothing else**: not the sender, not the edge, not a word of the
promise. The gate asserts that rather than documenting it.

Fabrication is prevented independently of hub honesty, because signatures are verified at the
recipient. A hostile hub can drop messages; it cannot forge one.

## Reconciliation decides nothing (§6.4)

`recon_request` carries `{edge_id, latest_assertion_hash}` per shared open edge; `recon_response`
returns the missing assertions.

Candidate assertions are fed through `verifyAssertionChain` from `@servanda/node`. **The transition
table stays the single authority on edge state** — federation never re-implements it and never
overrides it, so an invalid assertion arriving over the wire is discarded exactly as one arriving
locally would be (M-14). Divergence in content cannot occur after confirmation: content is the
hash, and changing it requires supersession.

Escalation is not reconciliation's business. Both sides seeing the same chain is all it promises;
what to do about an overdue promise is a local decision by the owner's own node.

## Recovery (§6.6) and anti-spam (§6.5)

Recovery responses carry **hashes only**. Plaintext recovery is a human act between counterparties,
never something a machine hands over (M-7). Responders verify the persona — or its rotation
successor — before answering.

Proposals from unknown senders are rate-limited, and level-0 senders are capped below a
client-configurable threshold. A `proposed` edge is socially nothing, which is what makes a Sybil
flood pointless rather than merely throttled.
