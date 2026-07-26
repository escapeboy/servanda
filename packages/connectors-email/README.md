# @servanda/connectors-email

Mail → §2 envelopes. **The path everyone who is not an engineer takes.**

Capture used to run through Claude Code sessions and GitHub. `ui-design.md` makes mail the
non-technical default — "connect mail in one OAuth click → first brief within the hour (sent-mail
archaeology fills Waiting in minutes)" — and §2 lists `imap` as a source. Scenario 3 depends on it:
the IMAP connector is what attaches a client's reply as evidence.

## What it captures

- **IMAP** → `email_in` / `email_out`. The client is an injected interface, so nothing needs a
  server to be tested.
- **Sent-mail archaeology** — the cold start for people with no repository. Mining *sent* messages
  finds promises made and answers awaited, which is what fills "Waiting" on day one.
- **BCC / forward** — capture without a screen, the mail form of an in-situ gesture.
- **Reply-as-evidence** — thread identity from `Message-ID` / `In-Reply-To` / `References`, so a
  later commitment can cite the reply through `evidence_refs`.

A connector emits envelopes or nothing. Whether something becomes a commitment or an expectation is
§3.4's decision, never this package's.

## Hostility

Email is the most hostile input in the system, and M-6 is the whole game: **content is data, never
instruction**. The suite exercises 23 hostile cases — header injection, malformed MIME, HTML with
scripts, spoofed `From`, invalid encodings, enormous bodies — and every one lands inertly in
`payload`.

**A display name is never an identity.** §1's ladder decides that (M-12); a mail connector that
treated `From: "Maria Ivanova"` as a party would hand an attacker a name for the price of a header.

## Determinism

Same mailbox, byte-identical envelopes, ids included. No clock in the envelope path: `occurred_at`
comes from the message's own `Date`, `received_at` is injected.

Two personas reading one mailbox share **no** envelope id — the same message observed by different
personas is a different observation, and M-5 keeps those pipelines apart.
