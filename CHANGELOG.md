# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version numbers below 1.0.0 carry no compatibility promise. This one carries an explicit
incompatibility promise — see *Scheduled break* below.

## [Unreleased]

The four spec resolutions that landed upstream as `servanda-protocol#28`. Every one of them
changes bytes on disk or the shape of a tool's answer, so a vault or a client built against
0.1.0-pre will not read what this produces.

### Changed — breaking

- **Domain separation on every identifier** (upstream #8, #16). `commitment_hash`, `edge_id` and
  the §2 envelope `id` are each hashed over `<tag> || 0x00 || <canonical form>`. Signing preimages
  are deliberately NOT tagged. Every identifier a 0.1.0-pre vault holds is different under this.
- **`acceptance_window` has no default** (upstream #5). An edge with `closure_policy:
  'on-acceptance'` and no window, or a window without that policy, is malformed: it rejects every
  assertion with `malformed-edge-acceptance-window`. The old implied P5D is gone — inventing a
  window is inventing consent.
- **`brief().primary_action` is a typed act, not a label** (upstream #20, M-21). `{act, tool,
  args}` replaces `{label, tool, args}`; a client maps the act to its own wording. Slots that
  offer nothing carry `null`.

### Added

- **`act`, the sixth §7 tool** (upstream #19, M-20). The only tool that signs an assertion:
  `done` and `release`. Before it, a promise could be recorded through §7 and never closed
  through it. `supersede`, `delegate` and `ping` are advertised bound to nothing — honest, where
  binding them to a tool that signs nothing would tell a person they had acted.
- **`open_loops` view `pending`** (upstream #27). The extraction-confirmation queue is readable
  at last; `confirm` takes an id and nothing used to hand one out.
- **Envelope bounds and the `clipped` marker** (upstream #18, M-19). Bounds are applied once, at
  the seal, in octets, cutting on Unicode scalar boundaries. An envelope that had to be cut says
  so; `clipped` is `true` or absent, never `false`.

- **M-17 and M-18** — §6.7 addressing. `verifyInboxRecord` rejects a record signed by anything but
  the persona it names, and says whether the signer was merely wrong or was somebody else's key;
  `hubsFor` returns the declared order untouched and returns nothing once the record has expired.
  The out-of-band bootstrap encodes, decodes and renders, and the courtesy renderer refuses an
  unverified payload rather than presenting it with a caveat — it holds no keys, which gate GF
  now proves by scanning the shipped module.

### Fixed

- `gates/must-coverage.sh` built its id list as `Array.from({length: 16})` and reported 16/16
  while M-20 went unchecked. It reads `MUST_IDS` now.
- Five gates captured that script's output with `|| true`, so a MUST with no test would have
  passed them.
- **Gate G0 counted vector files without noticing that nothing read them.** `addressing/`
  (4 + 2 cases) and `node-surface/verification-levels.json` (10 cases) were present, counted, and
  replayed by no test — a green gate over an oracle nobody consulted. G0 now fails when a required
  vector file is named by no test, and all three families are replayed.
- CI actions were still on Node 20 majors; bumped to `checkout@v7`, `setup-node@v7`,
  `pnpm/action-setup@v6`. `setup-node@v7` also drops the dummy `NODE_AUTH_TOKEN` fallback, which
  the OIDC publish path is better off without.

## [0.1.0-pre] — 2026-07-30

First public release. The reference implementation of the Servanda protocol, tracking spec
**DRAFT v0.1-pre**.

### Added

- **L0 — vault.** Encrypted, git-backed sovereign store: commitments, expectations, evidence,
  append-only assertion chains, retention decay. Argon2id at the §9.3 minimum (m=64 MiB).
- **L1 — edges.** The §4.3 transition table, with `verifyAssertionChain` as its single authority.
  Federation, adapters and clients all defer to it; nothing re-implements or overrides it.
- **L2 — federation.** Git and hub transports, reconciliation, edge recovery, anti-spam, blind
  courier. Additive: L0 and L1 work with no network, no server and no second participant (M-10).
- **L3 — clients.** A web ledger, a terminal register, an email brief, in-situ gestures, and the
  five §7 tools over MCP stdio.
- **Identity (§1).** Attestation, revocation boundary, domain anchor, the binding-proof ladder,
  rotation.
- **Capture.** Connectors for Claude Code sessions, GitHub archaeology and mail, all crossing one
  §2 envelope boundary. Tool-less schema-bound extraction (§3.4, M-6) with a precision harness.
- **Executors.** Sandboxed, capability-enumerated, draft-PR output only.
- **Conformance.** 100% of the vendored protocol vectors pass. Twelve gate scripts define done, and
  every M-1..M-16 has a named test that `gates/must-coverage.sh` demands.

### Scheduled break — read before creating a vault you care about

Upstream [#8](https://github.com/escapeboy/servanda-protocol/issues/8) and
[#16](https://github.com/escapeboy/servanda-protocol/issues/16) will add **domain separation to
every identifier preimage**. When they land, **every `commitment_hash`, every `edge_id` and every
envelope `id` changes.**

**Vaults created at this tag will not migrate.** The break is deliberately grouped into that one
change so it happens exactly once before v1 — issue #11 took direction A and #10 was ratified as-is
for precisely this reason. Two further resolutions land with it: a sixth §7 tool `act`
([#19](https://github.com/escapeboy/servanda-protocol/issues/19)), and `acceptance_window` becoming
required non-null iff `on-acceptance` ([#5](https://github.com/escapeboy/servanda-protocol/issues/5)),
which removes the current silent `P5D` default.

Treat this release as something to read, run and file issues against — not as somewhere to keep a
promise you need in a year.

### Known limitations

- **The cryptography has not been externally reviewed.** The Ed25519→X25519 birational map and the
  Argon2id parameters are unreviewed and tracked as
  [#7](https://github.com/escapeboy/servanda-protocol/issues/7). See [SECURITY.md](SECURITY.md).
- **No trademark clearance has been performed** on the name *Servanda*
  ([#1](https://github.com/escapeboy/servanda-protocol/issues/1)). The name is provisional.
- **Divergence from §2.** The spec says connectors are MCP servers implementing `emit_envelope`;
  these are libraries plus a hook script, and nothing here defines that tool. No gate catches it,
  because no MUST binds §2's connector surface and there is no conformance vector family for the
  node surface at all ([#25](https://github.com/escapeboy/servanda-protocol/issues/25)). Recorded as
  a divergence rather than fixed in either direction, because which side is wrong is a protocol
  question.
- Twenty-five spec ambiguities and contradictions are open upstream. Each is implemented at its
  narrowest reading and commented at the code site.
- Hosted operation, HPKE transport, threshold group signing, and formal verification of the
  transition table are out of scope for this implementation — not merely unimplemented.

[Unreleased]: https://github.com/escapeboy/servanda/compare/v0.1.0-pre...main
[0.1.0-pre]: https://github.com/escapeboy/servanda/releases/tag/v0.1.0-pre
