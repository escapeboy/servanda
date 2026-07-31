# @servanda/connectors-github

Repo archaeology and PR/CI events → §2 signal envelopes.

## Archaeology — value before configuration

```ts
const connector = new GithubConnector({ persona });
const envelopes = await connector.archaeology({ repoPath });
```

Mines a **local clone** with git plumbing only — no network, no API token, no forge account. It
finds commitments that already exist in the repository and nobody has written down:

| Kind | What it finds |
|---|---|
| `archaeology_todo` | TODO/FIXME comments, with the blame commit, author and age |
| `archaeology_stale_branch` | Branches dormant past a threshold |
| `archaeology_dead_flag` | Feature flags with a dead path behind them |
| `archaeology_unrun_migration` | Migrations absent from the applied ledger |

This is the cold-start answer (scenario 2): an hour after install, a user who has never spoken a
promise has a brief with real findings. No wizard, no "connect your calendar", no questions.

## Determinism is the contract

The same repository state produces the same envelope set — same ids, same order, byte for byte,
across separate processes. No `Date.now()` reaches the envelope path; traversal is sorted;
`received_at` is injectable.

That is not tidiness. Envelope ids are content hashes, `evidence_refs` point at them (§3.1), and a
commitment that cites an envelope must still cite the same envelope tomorrow.

## Webhook events

```ts
connector.fromWebhook(payload);   // pr_comment, pr_opened, push, check_run
```

Payloads are modelled locally; tests never call the GitHub API.

## M-6: data, never instruction

These connectors read attacker-reachable text — PR comments, issue bodies, TODOs written by
anyone. **No field of an envelope is ever interpreted as a command by any pipeline stage.**
Injection text lands inertly in `payload` and never reaches a field the core reads as control.

§2 now bounds `payload` (M-19, upstream issue #18) and this connector no longer clips anything on
its own: `sealEnvelope` applies the bounds for every connector alike, marks the envelope
`clipped: true` when it had to cut, and records the observed octet length as `<key>_length`. Only
scalars are lifted from nested structures. A 2 MB PR body should not become a 2 MB vault object.

That also ends an asymmetry this README used to have to describe: envelopes from here said nothing
about whether anything had been cut, while the two sibling connectors did. The marker now comes
from the shared boundary, so no connector can be silent about a truncation by omission.

## Fixture

`fixtures/archaeology-repo/` is generated, not committed — a nested `.git` inside the outer
repository would become a gitlink and break on a fresh clone.

```bash
bash fixtures/archaeology-repo/setup.sh
```

Every commit-hash input is pinned and git config is neutralized, so the generated repository has
the identical HEAD on every machine. Gate GB asserts that SHA — which is what proves
reproducibility, rather than "it worked here once". `EXPECTED.md` documents both the planted
findings and the control files that must stay silent.
