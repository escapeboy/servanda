# Architecture — implementing the v0.1-pre spec resolutions

Companion to [design-spec-v0.1-resolutions.md](design-spec-v0.1-resolutions.md). Every file and
line below was read on 2026-07-31, not inferred from names.

## 1. Domain separation (#8 + #16) — three sites, and one that must NOT change

The spec adds a fixed ASCII tag followed by a single `0x00` octet to the front of three preimages.
The tag contains no `0x00`, so it is self-delimiting.

| Identifier | Tag | Site |
|---|---|---|
| `commitment_hash` | `servanda/0.1:commitment_hash` | `packages/crypto/src/identity-hash.ts:31` (`commitmentHash`) |
| `edge_id` | `servanda/0.1:edge_id` | `packages/crypto/src/identity-hash.ts:47` (`edgeId`) |
| envelope `id` | `servanda/0.1:envelope_id` | `packages/envelope/src` sealing path; shape declared at `packages/types/src/envelope.ts:37` |

**`packages/crypto/src/sign.ts` must not be *tagged* — but it does change.** Two separate things,
and an earlier draft of this document conflated them:

- **No domain tag in the signing preimage.** The spec states this explicitly: a signature is
  already bound to its object by that object's own `type` and `v` members, inside the canonical
  form. Tagging there would break every signature vector for no gain. It is the easiest mistake to
  make while doing the other three, so it has its own negative test.
- **`unsigned()` must strip `sig_*`, not just `sig`.** PR #28 defines the §0 signing preimage as
  `sha256(JCS(O))` where `O` is the object minus **every member named `sig` or beginning with
  `sig_`**. `packages/crypto/src/sign.ts:14` strips only `sig`:

  ```ts
  const { sig: _sig, ...rest } = obj as T & { sig?: unknown };
  ```

  `packages/identity/src/rotation.ts:10` already documents the consequence — "the universal signing
  rule excludes only a field literally named `sig`, so a `sig_old` has no [preimage]" — which is
  exactly what upstream #17 was filed about. Multi-signature objects (`sig_A`/`sig_B`,
  `sig_old`/`sig_new`) currently hash their own signatures into their preimage.

### Consequences beyond the three identifiers

| Site | Change |
|---|---|
| `packages/crypto/src/sign.ts:14` | `unsigned()` strips `sig` **and** any `sig_*` |
| `packages/identity/src/rotation.ts` | The rotation statement becomes `{v, type, old, new, rotated_at, sig}`. The whole `acceptLegacySigOld` path and the `legacy-sig-old-encoding-unverifiable` reason exist only because #17 was open; the spec now mandates one form, so the legacy branch becomes a plain rejection |
| Persona linking (§1.6) | `{v, type, personas, sig_A, sig_B}`, both over `sha256(JCS({v, type, personas}))`, `sig_A` against `personas[0]`; **a link whose two signature members are byte-identical MUST be rejected** — a new negative case |

These are wire-shape changes, not identifier changes. They break separately from domain separation
and need their own tests.

`edge_id` derives from `commitment_hash`, so the change composes: a tagged commitment hash feeds a
separately tagged edge id. Both change; neither cancels the other.

**Blast radius.** `crypto` is a closed layer with zero outbound calls, so the change is contained
at the bottom and everything above recomputes. `vault` stores identifiers as written, so any vault
created before this is unreadable by construction — which the release already disclosed.

## 2. `acceptance_window` becomes required-or-null (#5)

`packages/node/src/transitions.ts:66`:

```ts
const window = edge.acceptance_window ?? DEFAULT_ACCEPTANCE_WINDOW;
```

That `??` is interpretation #5 and it goes away. After the change:

- `closure_policy === 'on-acceptance'` → `acceptance_window` MUST be present and non-null.
- Anything else → it MUST be null.

Make it unrepresentable rather than checked, per the house convention: the `Edge` schema in
`packages/types/src/edge.ts` should carry the constraint as a zod refinement so a malformed edge
cannot be parsed, and `windowElapsed` then reads a value it knows exists. A validation branch in
`transitions.ts` would be the weaker shape.

The rejection reason `acceptance-window-not-elapsed` stays — it is part of the contract with the
conformance suite and is never reworded. A *new* reason is needed for the malformed case; it must
match whatever the regenerated `transitions/invalid.json` names, so read the vector before naming
the constant.

## 3. The sixth tool, `act` (#19)

`packages/types/src/node-surface.ts:10` is the single source:

```ts
export const NODE_TOOL_NAMES = ['commit', 'expect', 'confirm', 'open_loops', 'brief'] as const;
```

Adding `'act'` there propagates through `NodeToolName` to every switch that is exhaustive over it —
which is the point of the shape and the reason this is not nineteen edits in nineteen places. What
does *not* propagate is prose. Nineteen mentions of "five tools" were enumerated:

- code/comments: `types/src/node-surface.ts:7`, `client-web/src/node-client.ts:15`,
  `client-web/src/stops.ts:10`, `client-web/src/index.ts:36,48`
- tests: `tui/test/tui.test.ts:141`, `client-local/test/register.test.ts:14`,
  `node/test/musts/M-08.test.ts:109`, `node/test/musts/M-10.test.ts:12,52`
- gates: `gates/ga-node.sh:46`, `gates/run-all.sh:13`
- docs: `README.md:43,119`, `docs/USAGE.md:62,161`, `packages/types/README.md:20`,
  `packages/tui/README.md:3`, `CHANGELOG.md:24`

`CHANGELOG.md:24` describes the **shipped** v0.1.0-pre and must keep saying five. It is history, not
a claim about current code. Every other one changes.

`act` carries `done` and `release`. It closes the hole where a promise could be recorded through
the contract and never closed through it.

## 4. `open_loops` gains `pending` (#27)

The confirm queue is writable through §7 (`confirm`) and unreadable through it — a client cannot
discover the ids it is expected to act on. `docs/USAGE.md:161` documents that gap in prose today;
after this it documents the view instead.

## 5. Typed `act` replaces `primary_action.label` (#20)

Clients do not trust node-supplied copy. `packages/client-web/src/copy.ts` owns every user-facing
string and the label arriving over a connection was the one exception. Replacing it with a typed
act closes that by construction — the client maps act → its own copy, and gate GE's vocabulary scan
keeps applying.

## 6. New MUSTs M-19, M-20, M-21

`packages/types/src/musts.ts:7` currently ends at `M-16`. Adding entries there is what makes
`gates/must-coverage.sh` demand a named test for each — the gate walks the `MUSTS` list, so the
list is the trigger, and adding a MUST without its test fails the gate by design.

Name them in the describe block, files at `packages/<pkg>/test/musts/M-NN.test.ts`. Placement
follows ownership: M-20 concerns the node surface (`packages/node`), and the other two land where
the rule lives once the upstream text is final.

## Order of work — DONE, shipped as v0.2.0-pre on 2026-07-31

1. ✅ `gates/sync-vectors.sh ../servanda-protocol`; watch G0 go red. That red is the spec.
2. ✅ `crypto` domain separation → G0 hashing green.
3. ✅ `types` — `NODE_TOOL_NAMES`, the `Edge` refinement, `MUSTS` entries.
4. ✅ `node` — `act`, `open_loops` pending, `windowElapsed` without its default.
5. ✅ Clients — typed act, copy table.
6. ✅ Prose sweep. It was twenty mentions, not eighteen, and two of them were not counts at
   all: `packages/e2e` asserted in prose that no §7 tool could reach `closed` or `released`,
   which `act` made false.
7. ✅ `gates/run-all.sh`, then the full suite, as separate runs.

### What the plan did not anticipate

- **M-19 needed the bounds moved, not added.** Each connector clipped its own payload strings,
  which keeps a value inside the bound and leaves the envelope silent about the cut — the one
  thing M-19 forbids. `sealEnvelope` is the only place that sees an envelope whole, so that is
  where §2 is applied now, and three connectors stopped clipping.
- **M-17 and M-18 were not in the plan and should have been.** Their `addressing/` vectors were
  vendored and counted by gate G0 and replayed by nothing. Adding a G0 check that each required
  vector file is *named by some test* found a third unread family in the same run: the §1.6
  verification ladder.
- **Three gate holes, all the same shape** — a check that could not fail. `must-coverage.sh`
  counted to a hardcoded 16; five gates captured its output with `|| true`; G0 counted files
  without noticing nothing read them.

## Last Updated

2026-07-31 (marked complete after the v0.2.0-pre release)
