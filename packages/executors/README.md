# @servanda/executors

The inversion at the heart of the product: **not a reminder — finished work awaiting approval.**
A reminder costs attention; a ready draft PR costs one review.

```ts
Executor: (commitment, context) → artifact_for_review
```

That is the whole interface, and it has been the whole interface since day one.

## Three classes, hardcoded

`tests` · `dead-code` · `dep-bump`. There is no fourth, and no plugin mechanism.

**The door for signals is wide open; the door for actions opens under control.** That asymmetry is
deliberate. A PR-writing executor is safe because its artifact waits for a signature; an
email-sending executor is a different risk class entirely. Scenario 6's attacker asks for a
GitHub Actions workflow that echoes secrets — and there is simply no class that could carry it.

Each class declares its capabilities, and they are enforced rather than documented: `tests` may
read `src/**` and `test/**` but write only `test/**`, at most 3 files and 400 lines.

## Containment

The sandbox denies the network (`fetch`, `dns`, `net`, `https`) and `child_process`, and
**replaces the environment** so CI secrets are absent from the executor's world.

Gate GD proves this rather than asserting it, with three layers:
1. positive controls, that each denial actually fires;
2. a control showing the denial comes from the trap rather than from an absent network;
3. a canary run **without** the env replacement, which sees `GITHUB_TOKEN` among 73 variables —
   so the scrubbing is demonstrably what does the work.

The artifact is then checked for both the names and the *values* of planted secrets.

An executor also never signs. **M-13: agents are never parties** — automation acts under a
persona, never as one, so the artifact is unsigned and a human's signature is the only thing that
can make it real.

The reviewer sees the human's own words via `intentForReviewer`, which is passed to the host and
never into the sandbox: §9.2 keeps free text out of executor contexts, but a reviewer needs to see
what they said. The host quotes it; the executor never reads it.

## Trust gradient — a measured quantity, not a permission

```
draft-for-review → auto-apply-with-window → silent-with-receipt
```

There is no "allow the agent to do X" setting. Autonomy is **derived from history** per
(human, work class): every approval without edits raises it, every correction lowers it.

Two properties make it safe:

- **Collapse is asymmetric.** One correction drops a class to the floor, and five subsequent
  approvals do not undo it. Trust is cheap to lose and slow to earn, which is the correct
  direction for a system that acts on your behalf.
- **Per-class ceilings hold regardless of history.** A ceilinged class never reaches silent no
  matter how good its record — fifty flawless artifacts still do not get there. This is the answer
  to the patient attacker in scenario 6, and the reason the gradient cannot be ground upward.

M-8 also applies here: an edge that cannot be verified never auto-escalates, so an executor will
not act on something the node cannot check.
