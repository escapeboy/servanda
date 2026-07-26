# @servanda/e2e

The scenarios from `docs/scenarios.md`, as automated tests. Gate **G3**.

Unit suites prove each package keeps its own promises. These prove the **seams** hold.

| Scenario | What it proves |
|---|---|
| 1 — solo cycle | A sentence somebody said out loud reaches a brief without anyone retyping it: session hook → envelope → tool-less extraction → pending queue → §7 `confirm` → sandboxed executor draft PR → brief line |
| 2 — cold start | A repository nobody has spoken to produces a brief within one run: archaeology → ingest → vault → brief, with no network, no counterparty and no configuration |

Writing these is what surfaced the missing **archaeology ingest path**: the GitHub connector
produced findings and nothing turned them into commitments. Two green streams with an empty seam
between them — exactly the failure integration tests exist to catch, and invisible to every unit
suite on both sides.

## Determinism

Every scenario drives an injected clock (`TestClock`), because a story whose outcome depends on
when it runs is not a test. The fixture repository regenerates to a pinned commit on any machine,
and G3 asserts it is byte-unchanged after the scenarios run — executors emit diffs, they do not
mutate trees.

## On the scripted model

Scenario 1 uses a scripted extraction response rather than the rule-based stub. The scenario exists
to prove the *chain*, and the chain must not be hostage to a regex table's judgement — the stub
reads "PaymentRetryService" as a counterparty. Extraction *accuracy* is a different question, owned
by the precision harness and answered by a human.
