# Contributing

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm -r run build
pnpm test           # full suite
pnpm gates          # every gate, in stage order
```

## The rule that governs every other rule

**The specification is normative. Code follows it, never the reverse.**

The spec lives in [servanda-protocol](https://github.com/escapeboy/servanda-protocol). The
conformance vectors vendored at `vendor/vectors/` are the oracle, pinned to the commit in
`vendor/vectors/.SOURCE_COMMIT`.

**A failing vector is never fixed by editing the vector.** `vendor/vectors/` is read-only here. If
a vector is wrong, that is a protocol issue upstream.

## Never resolve a spec ambiguity silently

Drafts contradict themselves; this one does, in twenty-five open places. When you hit one:

1. Implement the **narrowest** reading — the one that accepts least.
2. Comment it **at the code site**, naming the ambiguity and the reading taken.
3. File it upstream as a servanda-protocol issue.

Anything resembling a protocol *design change* goes to a protocol issue. It never goes into this
code, however obvious the fix looks from here.

## Gates define done

A stage is finished when its gate script passes, not when the tests are green. `gates/run-all.sh`
runs all of them; CI runs them on every push. A missing gate reports PENDING rather than passing
silently — absent and passing must never look the same.

`gates/must-coverage.sh` separately proves that every M-1..M-16 has a **named** test:

```
describe('M-14: assertions violating the table are discarded')
```

in `packages/<pkg>/test/musts/M-NN.test.ts`. A MUST with no test is a rule nothing enforces. Adding
a MUST without adding its test fails the gate, by design.

## Proving a negative

Claims like "it cannot reach the network" are proven in three moves, not one:

1. **Arm a trap** — a `--require` preload denying `fetch`, `dns`, `net`, `https`, `child_process`.
2. **Positive controls** — show each denial actually fires.
3. **The control that matters** — show the same call *without* the preload fails *differently*, so
   the denial is known to come from the trap and not from an absent network.

Every negative assertion needs its control. "Unverifiable edges never escalate" cannot be allowed
to pass merely because nothing escalates, so the same suite asserts that a verifiable overdue edge
**does**.

## Determinism is not optional

Connectors and archaeology must be byte-deterministic: same input, same envelope ids and ordering,
across separate processes.

- **No `Date.now()` in an envelope path.** `occurred_at` comes from the source event; `received_at`
  is injected. Clocks are injected in tests.
- Sorted traversal everywhere.
- **Never `toLocaleString` in rendered output** — it reads the machine's locale and zone, so the
  same brief would render differently on the laptop that composed it and the server that mailed it.

Envelope ids are content hashes and `evidence_refs` point at them (§3.1), so any change to
content — including clipping — must change the id.

## Two conventions that are easy to violate by accident

**Make illegal states unrepresentable rather than checked.** Before writing a validation, ask
whether the type system or an API shape can carry the rule instead. The extraction schema lets the
model say only `local_user` / `other_party` / `none`, so it cannot spell a key and therefore cannot
forge an owner. A gesture that would assert someone else's promise does not compile.

**No protocol vocabulary in anything a person reads.** The words *node, vault, MCP, edge, persona,
supersession, ledger* never appear in user-facing text. Gate GE greps for them across every
surface. Copy lives in one table, `packages/client-web/src/copy.ts`, and every surface imports it.
This file, and the rest of the developer documentation, is not user-facing text.

## Tests

- `RejectionReason` strings in `@servanda/types` are part of the contract with the conformance
  suite. **Never reword one.**
- CI runs the M-suite as `vitest -t 'M-'`, which executes M-named tests and **skips their
  siblings**. State assembled in one `it` and read in another is undefined under that filter — put
  shared state in `beforeAll`.
- A `toContain` over a whole document is a presence check, never a placement check. Browsers match
  rules by element, so assert on the element's class attribute, not on the document as a string.
- **Do not lower the Argon2id parameters to speed up tests.** That slowness is the security
  property. Lower the parallelism instead; the suite is memory-bound, not CPU-bound.

## Before you push

- **Commit the lockfile.** CI installs with `--frozen-lockfile`, so a stale lockfile fails all four
  jobs before a single test runs. `gates/run-all.sh` checks this first.
- **Local green is not CI green.** Both CI breakages this project has had were verified locally and
  never on a runner. Watch the run; do not report a status you have not read.
