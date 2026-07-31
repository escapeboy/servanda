# Design — implementing the v0.1-pre spec resolutions

**Status:** planning. Blocked on the upstream PR merging.
**Upstream design record:** `servanda-protocol/docs/decisions/ratification-packet-v0.1-pre.md` and
`gaps-packet-v0.1-pre.md`. Those two documents *are* the design for the protocol side; this file
does not restate them. It records what changes **here**, and why the sequencing is what it is.

## What this is

Nine ratifications and a handful of gaps, decided upstream on 2026-07-27. Most of them ratify what
this implementation already does — the narrowest reading was taken and filed as an issue rather
than resolved silently, so the spec is catching up to the code. Three do not, and those are the
work:

| Upstream | Decision | Effect here |
|---|---|---|
| #8 + #16 | Domain separation on every identifier preimage | **Every `commitment_hash`, `edge_id` and envelope `id` changes.** The one deliberate preimage break before v0.1 |
| #5 | `acceptance_window` required non-null iff `on-acceptance`, null otherwise | The silent `P5D` default disappears |
| #19 | A sixth §7 tool, `act`, carrying `done` and `release` | A five-tool contract becomes six, in ~19 places |
| #20 | `primary_action.label` replaced by a typed `act` | Clients stop rendering node-supplied copy |
| #27 | `open_loops` gains a `pending` view | The confirm queue becomes readable through §7 |
| #25, #26 | A node-surface vector family exists, M-12's ordering is pinned | New conformance surface to pass |

## Why it was blocked, and why it no longer is

The protocol side was written on 2026-07-27 and **sat uncommitted on disk for four days** while a
memory here recorded it as "produced nothing" — a conclusion drawn from GitHub having no branch and
no PR. It has now been verified green in place:

```
npm run selfcheck  → SELFCHECK PASSED — 749 checks, 0 failures
npm run validate   → SCHEMA VALIDATION PASSED — 11 files valid
```

including 11 action, 14 act-tool and 10 verification-level cases in the new `vectors/node-surface/`
family. So the spec work is not "to be written"; it is to be reviewed, committed and merged.

## The sequencing, and the one rule that fixes it

**The vectors are the oracle, and the oracle has to move first.** `vendor/vectors/` is read-only
here and a failing vector is never fixed by editing the vector, so implementing domain separation
before the regenerated vectors exist would mean writing code against hashes nothing can confirm.

1. Upstream PR merges.
2. `bash gates/sync-vectors.sh ../servanda-protocol` — re-pins `.SOURCE_COMMIT`.
3. G0 goes red across hashing, transitions, signatures and the new node-surface family. **That red
   is the specification.**
4. Implement until G0 is green again, then the rest of the gates.

There is a second reason to re-sync early regardless: `.SOURCE_COMMIT` is pinned at `e95ac96` while
protocol `main` is already at `8c63c9f`, so **the §6.7 addressing vectors from merged PR #21 were
never vendored here.** That drift predates this work and is fixed by the same command.

## What this release already promised

`v0.1.0-pre` shipped on 2026-07-30 with this break **scheduled and disclosed** — CHANGELOG,
SECURITY.md and the README status block all say that vaults created at that tag do not migrate.
Nothing here needs a migration path. That was the point of saying it in advance.

## What is explicitly not in scope

- **#1 trademark** and **#7 crypto review** stay open. The spec edit names both as gates on the
  freeze, which is honest, and neither is closed by writing that sentence.
- The **§2 `emit_envelope` divergence** is untouched. The new vector family covers §7, not §2's
  connector surface, so nothing about it becomes checkable here.
- HPKE (#6) remains deferred to v1.

## Last Updated

2026-07-31
