# @servanda/vault

The sovereign local store — L0. Encrypted, git-backed, and complete on its own: **a vault with no
network, no server and no counterparty is a fully working Servanda install** (M-10).

## Shape

```ts
const vault = await Vault.create({ path, passphrase, author });
const vault = await Vault.open({ path, passphrase });
```

The vault directory is its own git repository, and each mutating operation commits. That gives
history for free and makes the §6.1 git transport a natural later addition rather than a retrofit.
Content is encrypted with a content key that is wrapped per device **and** by a passphrase —
`sealContentKey` refuses any other arrangement (M-16).

## What it stores

Commitments, expectations, edges with their append-only assertion chains (§4.2), envelopes,
personas and keys, publish records, and the pending-extraction queue.

Assertion chains are append-only. A node retains the full chain, never a computed current state —
the state *is* the fold over the chain, so it can always be recomputed and always be audited.

## M-5: no org-context mixing

Reads are scoped by persona. A query that would combine two org personas' content is not
expressible through the ordinary API.

There is exactly one escape hatch, and it is named so it can be found:

```ts
export const CROSS_PERSONA_APIS = ['listOrderingKeysAcrossPersonas'] as const;
```

It returns **ordering keys, not content** — which is precisely the exception §5.3 permits: the
personal attention queue may *order* opaque items across personas; it may never transfer content
between them. Any future addition to that list is a constitutional change and should be treated as
one.

## M-15: retention decay

```ts
await vault.runRetention({ now });
```

After the owner-configured window, closed, expired, released and superseded edges lose their
commitment **plaintext**, while the edge and its full assertion chain are **preserved**.

That asymmetry is the whole point (ADR-0004): afterwards you can still *prove* that a promise was
made and kept, with dates and both signatures, and nobody — including you, including a court — can
reconstruct what it said. Remember *that*, not *what*.

Personal-scope escrow does not exist in this package. Not as a disabled flag, not as an option:
M-15 forbids it, so there is nothing to turn on.
