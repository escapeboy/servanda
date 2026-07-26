# @servanda/client-web

The one canonical surface. Seven views — **Brief**, **Owe / Waiting / Closed**, the **Confirmation
inbox**, the **team standup** and **Sources and trust** — plus two that stand outside it: the
**proof page** (a certificate at its own link) and **first run**.

Governed by `docs/ui-design.md`, which is doctrine rather than style guidance. The rules below are
enforced by gate GE, not left to review.

## The four product surfaces

- **Proof page** (`buildProof` / `proofEl` / `proofDocument`). A closed cross-org promise becomes a
  certificate anyone with the link can check: both parties with their evidence, the dates, the state
  chain, the commitment hash. It renders **from hashes alone** — after retention decay removes the
  plaintext (§5.4, ADR-0004, M-15) the certificate is unchanged, which is the entire point. The words
  of a promise are shown only when **both** parties consented; consent is per party, defaults to off,
  and is combined with `&&`, so no argument exists by which one party discloses for the other.
- **Team standup** (`buildTeam`). The blocking graph, built **only** from what a party chose to share
  into this team (M-4). Unshared promises and promises shared into another team are filtered out
  first, before anything is formatted. No per-person anything (M-11): your standup writes itself.
- **First run** (`buildOnboarding`). Sign up → connect → first note, with an offered, skippable,
  printable recovery sheet. Checked by `scanFirstRun`, which forbids technical vocabulary outright on
  this path — the word *install* included, by name.
- **Sources and trust** (`buildIntegrations`). Connected sources, and the trust gradient per kind of
  work. Rungs are **displayed but earned**: a rung carries no control, no focus stop and no id a
  handler could bind to, and locked rungs say what would open them.

## The register

**Notary, not coach.** A system that remembers your promises must feel like a registrar with
dignity, not a guilty conscience with notifications.

- Zero exclamation marks. Grep-enforced.
- States, not judgments: "open 12 days", never "overdue!!!".
- No streaks, scores, badges or gamification — gamification is reputation through the back door,
  and **M-11 applies to pixels**.
- No red-badge guilt mechanics.

## Vocabulary

User-facing strings say **owe / waiting / closed**. The words *node*, *vault*, *MCP*, *edge*,
*persona*, *supersession* and *ledger*-as-a-term do not appear in anything a person reads — they
die at the API boundary. Gate GE greps for them, and the scanner is itself tested against a known
violation so it cannot silently stop working.

This follows the non-technical-default law: any surface, flow or sentence that requires knowing what
a node or a vault *is* has violated the doctrine.

## The seal

The signature element is a wax seal, not a padlock — seals authenticated promises, and the metaphor
carries the semantics in one mark:

| State | Mark |
|---|---|
| proposed | outlined half-seal |
| confirmed | two half-seals joined — bilaterality made visible |
| closed | seal + mark |
| disputed | cracked seal |
| superseded | seal with an arrow to its successor |

Verification levels render as degrees of seal relief, and replace identity terminology entirely.
**M-12**: a display name is never rendered above its evidence level.

## Palette and type

Ink `#14120E` · Bone `#F7F4EC` (light is the default — a register, not a dashboard) · Wax `#8C2F1B`
**reserved exclusively for the seal** · Bronze `#C9A86A` for accent and verification. Dark mode is
inversion onto Ink. No gradients, no glows. Spectral for display, Public Sans for UI, JetBrains Mono
for hashes and evidence.

## Interaction laws

- Every card answers three questions at a glance: **what · with whom · what happens if I do nothing.**
- Action before description; the primary action leads the card, and Tab reaches it first.
- **No manual ordering, folders, tags or projects.** Order comes from the attention market. Forever.
- Full keyboard operation, native list/heading/button semantics, reduced motion respected.
- Offline-first rendering. The brief renders in well under its 100 ms budget from a local node.

What a person wrote is escaped, never interpreted — the same rule as M-6, one layer up.
