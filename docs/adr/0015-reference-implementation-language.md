# ADR-0015 — Reference implementation language is TypeScript

**Status:** Accepted · 2026-07-25
**Scope:** This repository (the reference implementation), not the protocol.

## Context

The Servanda protocol (spec v0, DRAFT v0.1-pre) is language-neutral: its normative surface is
canonical JSON (RFC 8785), SHA-256, Ed25519, and a five-tool MCP contract (§7). Any language can
implement it. The reference implementation still has to pick one.

## Decision

The reference implementation is written in TypeScript on Node 22+, as a pnpm monorepo.

Reasons, in the order they mattered:

1. **MCP SDK maturity.** The node surface (§7) *is* an MCP server, and connectors (§2) are MCP
   servers too. The TypeScript MCP SDK is the most complete and most exercised implementation;
   picking it removes protocol-surface risk from the layer where the spec is most concrete.
2. **Shared canonicalization with the vectors generator.** `tools/vectors-gen/` in
   servanda-protocol is TypeScript. RFC 8785 canonicalization has real teeth in JavaScript —
   number serialization follows the ECMAScript `Number::toString` algorithm, and key ordering is
   by UTF-16 code unit, which is JS's native string sort. Implementing the oracle and the
   implementation in the same language means a canonicalization disagreement is a bug in one of
   two places, not an unresolvable cross-language argument about float formatting.
3. **One language from node to client.** The node, the connectors, the executors, the TUI (Ink)
   and the web ledger share `@servanda/types` — the spec schemas as zod, compiled once. A
   commitment object cannot drift between the store that writes it and the UI that renders it.

## Consequences

- Cryptography comes from the audited `@noble/*` and `@scure/*` families rather than bindings:
  Ed25519, SHA-256/512, HMAC, Argon2id, XChaCha20-Poly1305, X25519, BIP-39. SLIP-0010 hardened
  derivation is implemented directly (~40 lines) because it is small and the vectors pin it.
- Argon2id at the §9.3 minimum (m=64MiB, t=3, p=1) costs ~1.2 s per derivation in pure JS. That is
  the correct cost for a passphrase KDF, but it means vault unlock is a deliberate act, not
  something to do per request.
- **A native rewrite of hot paths is an implementation detail, not a protocol matter.** Nothing in
  this decision reaches the wire. A future Rust node that passes the conformance suite is as much
  a Servanda node as this one — that is the point of ADR-0001.

## Alternatives considered

- **Rust** — better crypto story and a plausible eventual home for the vault. Rejected for v0: the
  MCP surface is where the risk is, and the reference implementation's job is to make the spec
  executable, not to be fast.
- **Go** — good middle ground, but neither the MCP nor the canonicalization argument favours it,
  and it would split the language of the oracle from the language of the implementation.
