# @servanda/types

Every Servanda protocol object as a zod schema plus its inferred TypeScript type, the §7 node
surface contract, and §8's MUST list as data.

One schema per spec object, imported by every other package — so a commitment cannot drift between
the store that writes it and the UI that renders it.

## What is here

| Module | Spec |
|---|---|
| `primitives` | Hex keys, signatures, RFC 3339 timestamps, ISO 8601 durations, the §1.6 verification ladder |
| `identity` | Attestation, revocation, domain anchor, binding proof, persona link, rotation (§1) |
| `envelope` | Signal envelope (§2) |
| `commitment` | Commitment, expectation, extraction output (§3) |
| `edge` | Edge, assertion, states, rejection reasons (§4) |
| `scope` | Scopes, scope descriptor, publish/unpublish (§5) |
| `wire` | Wire messages, hub envelope (§6) |
| `node-surface` | The five tools' input/output schemas (§7) |
| `musts` | `MUSTS` and `MUST_IDS` (§8) |

## The one distinction worth knowing

`Assertion.state` uses **`WireAssertionState`**, which admits `open`. **`AssertableState`** does
not.

This is deliberate and load-bearing. §4.3 marks `confirmed → open` as "(implicit)" with no signer,
so an explicit `open` assertion is invalid — and §4.3 requires the node to *discard* it with the
reason `implicit-transition-not-assertable`. If the parser rejected `open` outright, the node could
not report that reason, and an M-14 rejection would be indistinguishable from malformed JSON.

**Syntax is the parser's job; assertability is the transition table's.**

## Rotation accepts two encodings

`Rotation` accepts both `sig` and `sig_old`/`sig_new`, and requires at least one signature by the
old key. §1.7 names the fields `sig_old`/`sig_new`, but the universal signing rule excludes only a
field literally named `sig`, so §1.7's shape has no defined signing preimage — see upstream issue
#17. `RotationCanonical` is the single-`sig` form this implementation emits, because it is the only
one that can actually be signed.

A rotation nobody signed is never valid: it would hand an attacker every open edge of the rotated
persona.

## MUSTs as data

```ts
import { MUSTS, MUST_IDS } from '@servanda/types';
```

`gates/must-coverage.sh` walks this list and fails if any M-x has no named test. A MUST with no
test is a rule nothing enforces.
