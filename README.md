# Servanda — reference implementation

The reference implementation of the [Servanda protocol](https://github.com/escapeboy/servanda-protocol):
an open protocol for commitments — typed, evidenced, cryptographically owned records of promises
between people and organizations, with bilateral signed edges, sovereign local vaults, and
optional federation.

*Servanda*, from **pacta sunt servanda** — agreements must be kept.

> **Status:** in development against spec v0 (DRAFT v0.1-pre). Nothing here is published, deployed,
> or stable. The protocol is the product; this is the implementation that proves it runs.

## What it is

A promise is owned by its giver. It becomes real when the other party signs it — not before. It
lives in your vault, not on a server. It can be proven years later without anyone being able to
reconstruct what it said.

Those four sentences are not marketing; they are **M-1**, **M-2**, **M-10** and **M-15** of the
protocol's sixteen MUSTs, and each has a named test in this repository.

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
| `@servanda/crypto` | RFC 8785 JCS, SHA-256, Ed25519, SLIP-0010 `m/7391'`, BIP-39, XChaCha20-Poly1305, X25519 blind courier |
| `@servanda/vault` | Encrypted git-backed sovereign store; commitment / expectation / edge stores; retention decay |
| `@servanda/node` | Edge state machine (§4.3) and the five MCP tools (§7) |
| `@servanda/extraction` | Tool-less, schema-bound extraction (§3.4, M-6) |
| `@servanda/connectors-*` | Claude Code sessions, GitHub repo archaeology and PR/CI events → §2 envelopes |
| `@servanda/executors` | Sandboxed, capability-enumerated executors; draft-PR output only; trust gradient (§9.4) |
| `@servanda/client-web` · `@servanda/tui` · `@servanda/brief-email` | The Ledger, three renderers, one contract |

## Conformance is the definition

> "implements Servanda" means "passes the conformance suite" — GOVERNANCE.md, upstream.

The vectors in `vendor/vectors/` are the oracle, vendored from the protocol repo at the commit in
`vendor/vectors/.SOURCE_COMMIT`. They are read-only here. **A failing vector is never fixed by
editing the vector.**

The 19 negative transition vectors matter more than the positive ones. A verifier that accepts a
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
| GA | Vault + node | Negative transitions rejected; five tools answer offline; M-suite green |
| GB | Connectors | Deterministic archaeology; only valid §2 envelopes, ever |
| GC | Extraction | Schema-bound; precision harness runs (the ≥90% verdict is a **human** gate) |
| GD | Executors | Cannot reach network or CI secrets; produces a valid draft PR |
| GE | Clients | Brief < 100 ms; keyboard-only; zero protocol vocabulary in user-facing strings |
| G3 | Integration | Scenarios 1 and 2, end to end |

`gates/must-coverage.sh` separately proves every M-1..M-16 has a named test. A MUST with no test
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
upstream. Seventeen such issues are open against servanda-protocol; the vectors' README documents
eight more interpretations the generator had to make.

Anything resembling a design change goes to a protocol issue, never into this code.

## License

Apache-2.0 (see upstream issue #4 — the reference implementation's license is still open).
