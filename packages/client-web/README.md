# @servanda/client-web

The Ledger — the one canonical surface. Three views: **Brief**, **Owe / Waiting / Closed**, and the
**Confirmation inbox**.

Governed by `docs/ui-design.md`, which is doctrine rather than style guidance. The rules below are
enforced by gate GE, not left to review.

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
