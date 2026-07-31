# Test plan — implementing the v0.1-pre spec resolutions

Companion to [architecture-spec-v0.1-resolutions.md](architecture-spec-v0.1-resolutions.md).

## The acceptance criterion, stated once

**G0 green against the regenerated vectors, with `vendor/vectors/` unedited.** Everything else is
downstream of that. A failing vector is never fixed by editing the vector; if a vector looks wrong,
it is an upstream issue.

## Order of evidence

1. `bash gates/sync-vectors.sh ../servanda-protocol` → `.SOURCE_COMMIT` re-pins.
2. `bash gates/g0-vectors.sh` → **expected RED**, across hashing, transitions, signatures and the
   new node-surface family. Record which families fail *before* touching code; that list is the
   work, and a family that does *not* go red where it was expected to is itself a finding.
3. Implement. G0 green.
4. `bash gates/must-coverage.sh` → demands M-19, M-20, M-21.
5. `bash gates/run-all.sh`, then `npx vitest run` **as a separate run**.

## Per-change cases

### Domain separation (#8 + #16)

| Case | Expectation |
|---|---|
| `commitmentHash` over the vectors' inputs | Matches regenerated `hashing/commitment-hash.json` exactly |
| `edgeId` over a tagged commitment hash | Matches regenerated vectors; composes, does not cancel |
| Envelope `id` | Matches; and **changing any payload byte still changes the id** — the §3.1 property that made clipping detectable must survive tagging |
| **`sign.ts` unchanged** | `signatures/signatures.json` passes **unmodified**. This is the negative control: if signature vectors move, a domain tag leaked into the signing preimage |
| An identifier computed under the old rule | Does **not** validate. No silent acceptance of pre-break ids |

The signature case is the one that catches the likely mistake, so it is written as an explicit
assertion rather than left to "G0 passes".

### `acceptance_window` (#5)

| Case | Expectation |
|---|---|
| `on-acceptance` with a window | Parses; tacit close valid only after it elapses |
| `on-acceptance` with `null`/absent | **Fails to parse.** Not "is rejected later" — unrepresentable at the schema |
| Non-`on-acceptance` with a window set | Fails to parse |
| Tacit close before the window elapses | `acceptance-window-not-elapsed`, string unchanged |
| The old `P5D` fallback | Gone: an edge that used to close on the default now cannot be constructed |

**Control:** the last row matters most. Without it, "the default is gone" could pass merely because
no test exercises a windowless edge.

### The sixth tool `act` (#19)

| Case | Expectation |
|---|---|
| `act` over the real wire | The end-to-end probe spawns `servanda-node` and calls `act` as a client importing nothing from the implementation; `stderr` stays empty |
| `done` and `release` | Each drives the edge to the state the transition table says, via `verifyAssertionChain` — no second authority |
| `act` on an edge the caller does not own | Refused (M-1) |
| Unknown act value | Rejected as invalid input, not silently ignored |
| Offline | Answers with networking denied, like the other five (M-10) |

### `open_loops` pending view (#27)

| Case | Expectation |
|---|---|
| Items in the confirm queue | Appear in the `pending` view with ids that `confirm` accepts |
| Round trip | An id read from `pending` and passed to `confirm` resolves the item — the loop `docs/USAGE.md:161` says is broken today |
| Empty queue | Empty view, not an error |

### Typed `act` in `actions` (#20)

| Case | Expectation |
|---|---|
| No node-supplied copy reaches a client | Gate GE's vocabulary scan still passes, and no rendered string originates from the node |
| Every act maps to copy | `packages/client-web/src/copy.ts` has an entry per act; a missing one fails at build, not at render |

### M-19, M-20, M-21

Each gets a named test — `describe('M-NN: <the rule, in words>')` — at
`packages/<pkg>/test/musts/M-NN.test.ts`. `gates/must-coverage.sh` walks the `MUSTS` list and fails
if any id lacks one, so adding the entry without the test fails the gate by design.

## Regression surface

- **The M-suite filter.** CI runs `vitest -t 'M-'`, which executes M-named tests and skips their
  siblings. State assembled in one `it` and read in another is undefined under that filter — shared
  state goes in `beforeAll`. Gate G3 runs that exact filter.
- **Six scenarios.** `packages/e2e` must still pass, and G3 names each file explicitly so the gate
  cannot pass by omission. Scenarios 3 and 6 make negative claims; they must keep making them.
- **Determinism.** Connector and archaeology envelope ids change with the tag. The property to
  re-verify is not the value but the invariant: same input, byte-identical output across two
  processes, and `evidence_refs` still pointing at ids that exist.
- **Teardown.** Temp-dir cleanup carries `maxRetries` at all fourteen sites; new fixtures must too,
  or a green suite reports red on a hook (`mem:testing-strategy`).

## What would make this plan wrong

If the regenerated vectors do **not** go red where step 2 expects, either the sync did not take or
the upstream change is narrower than the packet says. Investigate before implementing — writing
code against an oracle that did not move is how a break gets half-applied.

## Last Updated

2026-07-31
