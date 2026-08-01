# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version numbers below 1.0.0 carry no compatibility promise, and these releases have used it: every
one so far changes derived keys. A vault does not migrate across any of them.

## [Unreleased]

### Added

- **The specification is frozen at v0.1** (2026-08-01, conformance suite `0.1.0`,
  [servanda-protocol@v0.1](https://github.com/escapeboy/servanda-protocol/releases/tag/v0.1)). A
  normative change now requires `servanda/0.2`. This package tracks the frozen text; the freeze
  says nothing about *this* package's stability, and every 0.x release so far has broken a vault.

- **§2 envelope conformance vectors, replayed here** (`packages/envelope/test/envelope-vectors.test.ts`,
  upstream `vectors/envelope/`). Until now M-19 and the §2 `id` preimage were enforced only by
  tests this project wrote about its own code — §8 said so itself, and `GOVERNANCE.md` draws the
  consequence that a behaviour the suite does not cover is not yet a conformance requirement. Two
  MUSTs were optional in practice.

  Replaying them found the disagreement worth having: the vectors and this implementation counted
  payload nesting differently. **The vectors were wrong** — §2 bounds the level of a *value*, so
  the scalar at the bottom of a chain occupies a level, and the generator's measure had been
  counting containers and reading 7 where §2 reads 8. It agreed with itself, which is why it
  passed alone. Fixed upstream.

- **Upstream [#36](https://github.com/escapeboy/servanda-protocol/issues/36)**, filed rather than
  resolved here: §2 says two nodes observing one event MUST compute the same envelope `id`, but the
  preimage includes `persona` and the observing node's own `received_at`, neither of which the
  sentence names and neither of which independent observers can agree on. The vectors encode the
  construction, which is unambiguous, and take no position on the sentence.

## [0.4.0-pre] — 2026-08-01

### Changed — breaking

Everything the upstream v0.1-freeze resolutions asked for
([servanda-protocol#35](https://github.com/escapeboy/servanda-protocol/pull/35), closing #3, #6,
#30, #31, #32, #33).

- **The transport is HPKE (RFC 9180) Base mode** — DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 /
  ChaCha20-Poly1305 — implemented on the `@noble` primitives already here, so no dependency was
  added to a package whose narrow graph is itself a security property. §6.3 used to say "ECDH then
  an AEAD" and leave the KDF, the context binding and the nonce derivation unstated, which is the
  assembly RFC 9180 exists to prevent.

  **The gain is an oracle.** `packages/crypto/test/hpke-rfc9180.test.ts` replays Appendix A.2 and
  checks every intermediate — Encap, Decap, the key schedule, the ciphertext — against numbers
  written by people who have never seen this protocol. The hand-assembled construction could never
  have that: its correctness was whatever the implementation happened to do.

  **No nonce travels any more.** HPKE derives it from the key schedule, so a sender cannot choose,
  reuse or leak one, and the sealed envelope is one field smaller.

- **A wire message names its recipient, inside the signature.** Without it a signature said who
  wrote a message and nothing about whom they wrote it to, so any recipient could re-seal a
  validly-signed message to a third party and it verified there unchanged. The inbox refuses it
  with its own reason — `addressed-to-another-persona`, not `signature-does-not-verify`, because a
  forwarded message and a corrupt one are different events and an operator needs to tell them
  apart. `recon_request` and `recover_request` had no party check of their own, which is what made
  this worth fixing at the envelope rather than per type.

- **`disputed → expired` after a 30-day window.** Both resolutions require both parties, so
  disputing was a unilateral act that froze an edge permanently. Expiry decides nothing about the
  merits and the rejection reason says so — `dispute-window-not-elapsed` names a window, never a
  verdict.

- **`dh_key` is required in the §6.7 inbox record**, now that #33 is merged rather than proposed.

### Fixed

- **`ItemAction` and `BriefSlot` reject an unknown member instead of stripping it.** zod strips by
  default, so a `label` arriving from another node was silently dropped: this node would never
  emit one, and a client using these types to read someone else's `brief` could never *detect*
  one either. Stripping is not rejecting, and the normative schema says
  `additionalProperties: false`. Found by the new `node-surface/brief-slots.json` oracle
  (servanda-protocol#34, closing #29) on its first replay — the family exists because nothing
  pinned a `brief` slot, and it earned its place immediately.
- **`ItemAction` consults the act→tool binding table.** `{act: 'supersede', tool: 'act'}` parsed
  happily: an advertised call to a tool that signs nothing, which is M-20's whole subject. The
  table lives in the same module, so the schema reads it rather than restating it.
- Gate G0's required-family list gained `node-surface/brief-slots.json`. It reported PASS in the
  gap between the vectors landing and the list being updated — a family absent from that list is
  invisible to all three of G0's checks, which is why it is written out rather than globbed.

## [0.3.0-pre] — 2026-07-31

Everything here comes out of pre-reviewing the upstream cryptographic gate
([#7](https://github.com/escapeboy/servanda-protocol/issues/7)), written up in
[docs/crypto-review-packet.md](docs/crypto-review-packet.md). Every change alters a derived key, so
a 0.2.0-pre vault does not open and a 0.2.0-pre sealed payload does not decrypt.

### Changed — breaking

- **Personas have their own X25519 key** (`m/7391'/{n}'/1'`), and the Ed25519 → X25519 birational
  map is gone from the sealing path entirely. This does not answer #7's key-reuse question — it
  removes it. Standard primitives used in standard ways need no novel analysis, and the issue
  names this way out itself. Proposed upstream as
  [#33](https://github.com/escapeboy/servanda-protocol/issues/33).

  The key rides in the §6.7 inbox record: already signed, already guarded by M-17, and already
  required to reach a persona over a hub — so it adds no published statement an observer could
  compare, which §1.2's unlinkability would not have survived. Only the hub transport seals (git
  confidentiality *is* repository access), so a persona federating over git, or not at all (M-10),
  needs no DH key and publishes nothing. Rotation comes free with the record's 30-day life.

  `sealToPersona` takes the recipient's key and cannot compute one, so the fallback to the old
  construction is not a mistake to avoid — it is unreachable, and gate GF proves it over the
  shipped module. `HubClient` refuses to send when no verified key resolves: refusing costs a
  round of reconciliation, which §6.7 already guarantees, while sealing to an unauthenticated key
  costs the confidentiality §6.3 exists for.

  `dh_key` is optional in the schema only because #33 is a proposal rather than merged text. The
  vendored addressing vectors predate it and are never edited to suit an implementation, so a
  record without the field still parses and still verifies over exactly the canonical form the
  oracle pins. It simply cannot receive anything.

- **The blind-courier seal binds the persona, not a y-coordinate.** The birational map is 2-to-1:
  `u = (1 + y)/(1 − y)` uses only the y-coordinate, so a `persona_id` and its negation are distinct
  identifiers sharing one X25519 key. The full `persona_id` is folded into the HKDF `info`. This
  landed before the key separation above and still matters: it ties a ciphertext to *who* it was
  for, rather than to whichever key that identity currently advertises. §6.3 specifies no key
  schedule at all — [#30](https://github.com/escapeboy/servanda-protocol/issues/30).

- **The hub envelope's readable fields are now immutable.** `recipient` and `sent_at` sit outside
  the ciphertext because a courier needs them, and outside meant unauthenticated — a hub could
  rewrite `sent_at` on anything it held. Bound as AEAD associated data: still readable, no longer
  editable.

- **Device keys are derived, not used raw.** `wrapForDevice` passed the caller's bytes straight to
  the AEAD, sound only if every caller supplied 32 uniformly random bytes and nothing said so. One
  HKDF with a domain-separation label, plus a 32-byte floor that refuses short input rather than
  stretching it — a KDF spreads entropy and cannot create it.

### Fixed

- **The vault no longer lets git rewrite it in the background.** git forks a detached
  `gc --auto` after commits, which keeps writing into `.git/objects` after the synchronous command
  returns. `gc.auto=0` on the vault's and the federation transport's invocations. It surfaced as a
  flaky teardown, but it is the right fix on its own terms: a library-managed store should not
  rewrite itself while its owner believes it is idle.

### Filed upstream rather than fixed here

Two findings were protocol text, not code: [#31](https://github.com/escapeboy/servanda-protocol/issues/31)
(a wire message names no recipient, so a signature binds who sent it and not who it was for) and
[#32](https://github.com/escapeboy/servanda-protocol/issues/32) (§9.3's "minimum" reads as three
independently tunable floors). §6.2's message shape and §9.3's wording are normative, so changing
them here would have been a design change in the wrong repository.

**The gate itself is not discharged.** Whether one key pair may both sign and do Diffie-Hellman is
the actual subject of #7 — but it is no longer a question this implementation depends on.

## [0.2.0-pre] — 2026-07-31

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
- **§6.7 store-and-forward.** `deliverViaInbox` walks a persona's declared hubs in the order they
  declared, stops at the first that accepts, and refuses to route at all on a record it has not
  verified or one that has expired. Every hub failing returns an outcome rather than throwing:
  §6.7 makes delivery an optimization and reconciliation the guarantee, and a caller forced to
  catch would be pushed toward treating a hub as durable.
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
- **Trusted publishing had never been used.** Eighteen publishers were configured and the publish
  job ran Node 22 — npm 10.9, which has no OIDC support at all — so both 0.1.0-pre and 0.2.0-pre
  went out on a token while every observable signal (green run, signed provenance, registry
  metadata) matched what a working OIDC publish produces. The publish job runs Node 24 now, and
  `gates/oidc-probe.sh` proves the exchange for every package before anything is published: npm
  performs the OIDC exchange *before* honouring `--dry-run`, so the proof costs nothing and
  publishes nothing. `NODE_AUTH_TOKEN` is gone from the publish step. Proven 2026-07-31: 18/18
  exchanged a token with no token in the environment.

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

[0.3.0-pre]: https://github.com/escapeboy/servanda/releases/tag/v0.3.0-pre
[0.2.0-pre]: https://github.com/escapeboy/servanda/releases/tag/v0.2.0-pre
[0.1.0-pre]: https://github.com/escapeboy/servanda/releases/tag/v0.1.0-pre
