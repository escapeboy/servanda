# Security

## Status of this release

**v0.1.0-pre is a pre-release. The cryptography has not been externally reviewed.**

Two things are specifically unreviewed, both tracked upstream as
[servanda-protocol#7](https://github.com/escapeboy/servanda-protocol/issues/7):

- the **Ed25519 → X25519 birational map** used to derive the blind-courier encryption key from a
  signing key, and
- the **Argon2id parameters** the vault derives its content key with (§9.3 minimums: m=64 MiB).

Do not use this release to protect anything whose loss would matter. The vault format, the key
derivation and the identifier preimages will all change before v1 — see
[CHANGELOG.md](CHANGELOG.md) for the specific break already scheduled.

## Reporting a vulnerability

Report privately through **[GitHub private vulnerability
reporting](https://github.com/escapeboy/servanda/security/advisories/new)**. Do not open a public
issue for a vulnerability.

This is a single-maintainer project. Expect acknowledgement within a week; expect a fix on a
best-effort schedule, not a contractual one. If a report is valid and you want credit, say so and
you will be credited in the advisory.

## What is in scope

Anything that breaks one of the sixteen MUSTs in `@servanda/types`, in particular:

| Area | The property that must hold |
|---|---|
| Vault (`@servanda/vault`) | Ciphertext at rest reveals nothing about commitments; retention decay actually destroys |
| Key derivation (`@servanda/crypto`) | SLIP-0010 `m/7391'`, BIP-39 recovery, sealed keysets (M-16) |
| Transitions (`@servanda/node`) | `verifyAssertionChain` is the single authority; a forged or out-of-table assertion is discarded (M-14) |
| Ownership (M-1) | A node cannot be made to assert a promise it does not own, through any surface |
| Connectors | Attacker-authored text (PR comments, TODOs, mail) is carried as data, never as instruction (M-6) |
| Executors | The sandbox cannot reach the network or read CI secrets; output is draft-PR only |
| Federation | A hub learns nothing about the content it forwards |

Input that comes from another person is hostile input. Reports that show attacker-controlled text
reaching an instruction path, an identifier, or a signature preimage are the most valuable ones.

## What is out of scope

- **The protocol itself.** An ambiguity, contradiction or weakness in the *specification* belongs
  on [servanda-protocol](https://github.com/escapeboy/servanda-protocol/issues), not here. This
  repository implements the spec; it does not decide it.
- **Hosted operation, HPKE transport, and threshold group signing** — explicitly out of scope for
  this implementation, not merely unimplemented.
- **The unreviewed crypto named above.** It is already known and filed; a report that restates it
  adds nothing. A report that shows a *concrete* break in it is very much in scope.
- Findings that require an attacker who already has the vault passphrase or the device's private
  keys.
