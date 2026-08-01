# Servanda — reference implementation

The reference implementation of the [Servanda protocol](https://github.com/escapeboy/servanda-protocol):
an open protocol for commitments — typed, evidenced, cryptographically owned records of promises
between people and organizations, with bilateral signed edges, sovereign local vaults, and
optional federation.

*Servanda*, from **pacta sunt servanda** — agreements must be kept.

> **Status: v0.4.0-pre**, tracking spec v0 (DRAFT v0.1-pre). The protocol is the product; this is
> the implementation that proves it runs.
>
> **A vault does not migrate across any 0.x release so far.** 0.2.0-pre took the scheduled
> domain-separation break; 0.3.0-pre gave personas their own X25519 key; 0.4.0-pre replaced the
> transport with HPKE and put the recipient inside the signature. Each changes keys or
> identifiers a previous vault holds — see [CHANGELOG.md](CHANGELOG.md).
>
> **The cryptography has not been externally reviewed** — see [SECURITY.md](SECURITY.md). Upstream
> [#7](https://github.com/escapeboy/servanda-protocol/issues/7) is closed, and it is worth being
> exact about how. Its harder half is *gone*: a persona signs with one key and performs key
> agreement with another, so the key-reuse it asked about is not something this implementation
> does, and the transport is now RFC 9180 HPKE replayed against the RFC's own test vectors. Its
> other half — the Argon2id parameter set — was **accepted by the maintainer**, not cleared by a
> cryptographer. An accepted parameter set is a decision; it is not a review.
>
> Read it, run it, file issues against it. Do not yet keep in it a promise you need in a year.

## What it is

A promise is owned by its giver. It becomes real when the other party signs it — not before. It
lives in your vault, not on a server. It can be proven years later without anyone being able to
reconstruct what it said.

Those four sentences are not marketing; they are **M-1**, **M-2**, **M-10** and **M-15** of the
protocol's MUSTs, and each has a named test in this repository — as does every other MUST §8
places on a node.

## Getting started

From npm:

```bash
npm install -g @servanda/node        # servanda-init, servanda-node
npm install -g @servanda/tui         # the terminal register

export SERVANDA_VAULT=~/.servanda
export SERVANDA_PASSPHRASE='something only you know'
servanda-init                        # creates the vault, prints your recovery phrase
servanda-node                        # the six §7 tools over MCP stdio
```

Or from source:

```bash
pnpm install && pnpm -r run build

export SERVANDA_VAULT=~/.servanda
export SERVANDA_PASSPHRASE='something only you know'
node packages/node/dist/bin/servanda-init.js     # creates the vault, prints your recovery phrase
node packages/node/dist/bin/servanda-node.js     # the six §7 tools over MCP stdio
```

Then point a client at it — your assistant, the terminal register
(`node packages/tui/bin/servanda.mjs --ink`), or the email brief.

**[docs/USAGE.md](docs/USAGE.md)** walks the whole path: creating and restoring a vault, capturing
from sessions, repositories and mail, reading the register, working with a counterparty, letting
executors draft the work, and checking what extraction actually finds.

## Layering

```
L3  Clients (assistants, web ledger, TUI, email brief) — via the node surface (§7)
L2  Federation (reconciliation, hubs, transports) (§6)
L1  Edges (bilateral signed promises) (§4)
L0  Vault (sovereign local store: commitments, expectations, evidence) (§3)
```

**L0–L1 work with no network, no server, and no second participant** (M-10). L2 is additive.
Solo use is complete use.

## Packages

| Package | What it does |
|---|---|
| `@servanda/types` | Every spec object as a zod schema + TS type; the §7 tool contract; §8's MUST list as data |
| `@servanda/crypto` | RFC 8785 JCS, SHA-256, Ed25519, SLIP-0010 `m/7391'`, BIP-39, XChaCha20-Poly1305, X25519 blind courier on a key of its own |
| `@servanda/vault` | Encrypted git-backed sovereign store; commitment / expectation / edge stores; retention decay |
| `@servanda/node` | Edge state machine (§4.3) and the six MCP tools (§7) |
| `@servanda/identity` | §1 verification: attestation, revocation boundary, domain anchor, the binding-proof ladder, rotation |
| `@servanda/federation` | §6: git and hub transports, reconciliation, edge recovery, anti-spam, blind courier |
| `@servanda/adapters` | Verification adapters: evidence bundles for §4.4 closure, and what makes an edge unverifiable (M-8) |
| `@servanda/extraction` | Tool-less, schema-bound extraction (§3.4, M-6) |
| `@servanda/envelope` | The §2 envelope boundary every connector crosses: payload bounds, undefined-stripping, sealing |
| `@servanda/connectors-*` | Claude Code sessions, GitHub archaeology, mail (IMAP, sent-mail archaeology, BCC/forward) → §2 envelopes |
| `@servanda/gestures` | In-situ capture and confirmation — confirm a promise where it was spoken |
| `@servanda/executors` | Sandboxed, capability-enumerated executors; draft-PR output only; trust gradient (§9.4) |
| `@servanda/client-local` | A `NodeClient` backed by a real vault — what lets a client show *your* register, not a sample |
| `@servanda/client-web` · `@servanda/tui` · `@servanda/brief-email` | The Ledger, three renderers, one contract |

## Conformance is the definition

> "implements Servanda" means "passes the conformance suite" — GOVERNANCE.md, upstream.

The vectors in `vendor/vectors/` are the oracle, vendored from the protocol repo at the commit in
`vendor/vectors/.SOURCE_COMMIT`. They are read-only here. **A failing vector is never fixed by
editing the vector.**

The 23 negative transition vectors matter more than the positive ones. A verifier that accepts a
`confirmed` assertion signed by the owner rather than the counterparty has silently discarded the
entire confirm-first guarantee — and would still pass every positive test.

## Gates

A stage is done only when its gate script passes. Gates run in CI on every push.

```bash
pnpm gate:g0    # Foundation: vector conformance
pnpm gates      # Every gate, in stage order
```

| Gate | Stage | Proves |
|---|---|---|
| G0 | Foundation | 100% of the protocol vectors pass |
| GA | Vault + node | Negative transitions rejected; six tools answer offline; M-suite green |
| GB | Connectors | Deterministic archaeology; only valid §2 envelopes, ever |
| GC | Extraction | Schema-bound; precision harness runs (the ≥90% verdict is a **human** gate) |
| GD | Executors | Cannot reach network or CI secrets; produces a valid draft PR |
| GJ | Adapters | Evidence hashes reproducibly; an unverifiable edge never auto-escalates |
| GK | Email | Deterministic capture; 23 hostile-input cases land inertly |
| GL | Gestures | Confirming another's promise does not compile; no network from any path |
| GF | Federation | Two nodes converge on one chain offline; a hub learns nothing |
| GG | Identity | The ladder and its downgrades; every forgery fails |
| GE | Clients | Brief < 100 ms; keyboard-only; zero protocol vocabulary in user-facing strings |
| G3 | Integration | All six scenarios, end to end |

`gates/must-coverage.sh` separately proves every §8 MUST has a named test. A MUST with no test
is a rule nothing enforces.

## Development

```bash
pnpm install
pnpm test           # full suite
pnpm typecheck
pnpm gates
```

Requires Node 22+ and pnpm 10. See [`docs/AGENT-BRIEF.md`](docs/AGENT-BRIEF.md) for the working
agreement and [`docs/adr/`](docs/adr/) for decisions taken in this repo (ADR-0001–0014 are
upstream, in the protocol repo).

## When the spec is wrong

The spec is a draft, and drafts contradict themselves. The rule here is: **never resolve a spec
ambiguity silently.** Implement the narrowest reading, comment it at the code site, and file it
upstream. Nine are open against servanda-protocol — twenty-two were closed by its v0.1-pre
resolutions, and four of the nine were filed from here while pre-reviewing the cryptographic gate
— and the vectors' README documents the interpretations the generator had to make.

Anything resembling a design change goes to a protocol issue, never into this code.

### Known divergence

One place where this implementation does not follow the spec, recorded here rather than argued
away:

**§2 says connectors are MCP servers implementing `emit_envelope`. These are not.** The connectors
here are libraries plus a hook script; nothing in the repository defines an `emit_envelope` tool.
No gate catches this, and the reason has narrowed: no MUST binds §2's connector surface. The
second reason this paragraph used to give — that no conformance vector family pinned any tool
contract — stopped being true when upstream #25 closed and `vendor/vectors/node-surface/` landed.
§7 is pinned by 35 cases now; §2's connector surface still is not.

Which side is wrong is a protocol question, not an implementation one — a connector that is a
library composes into a node without a second process, which may be the better design, or may be a
shortcut the spec should overrule. It is filed as a divergence rather than fixed in either
direction.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) has the working rules — the spec is normative, a failing vector
is never fixed by editing the vector, and gates define done. Vulnerabilities go through
[SECURITY.md](SECURITY.md), never a public issue.

## License

Apache-2.0. See [LICENSE](LICENSE).
