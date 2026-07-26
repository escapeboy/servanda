# @servanda/connectors-email

Mail → §2 signal envelopes. `source: "imap"`.

Capture today runs through Claude Code sessions and GitHub — that is, through engineers.
`ui-design.md` makes mail the **non-technical default path**: connect mail in one OAuth click,
first brief within the hour, sent-mail archaeology fills "Waiting" in minutes. Without this
package the product only works for people who live in a terminal.

## What it emits

| Method | Kind | What it is |
|---|---|---|
| `capture` / `fromMessage` | `email_in`, `email_out` | Ordinary IMAP capture. |
| `sentArchaeology` | `archaeology_sent_promise`, `archaeology_sent_question` | The cold-start move: promises made and answers awaited, mined out of Sent. |
| `fromDelivered` / `fromRawDelivered` | `email_bcc`, `email_forwarded` | The in-situ gesture — BCC or forward to the node's address, original preserved as payload. |

A connector emits **envelopes or nothing**. Whether a mined sentence becomes a §3.1 commitment
or a §3.3 expectation is §3.4's decision, downstream, tool-less and schema-bound. This package
never makes it.

## The IMAP client is injected

```ts
const connector = new EmailConnector({
  persona,                                   // M-5: bound at construction, never per call
  addresses: ['me@example.com'],             // which mailbox this node IS — registration data
  sentMailboxes: ['Sent'],
});

const envelopes = await connector.capture(client, { receivedAt });
```

`client` satisfies `ImapClient` (`listMailboxes` + `fetchAll`) and is constructed by the caller.
This package ships two implementations for testing — `FixtureImapClient` (a directory of `.eml`
files) and `MemoryImapClient` — and no transport. A real one (`imapflow`, a Gmail API shim) is
the caller's. Two consequences: the whole package is testable offline, and the connector never
owns the credential. Gate GK proves the package cannot reach the network at all, which is only
true because the transport lives outside it.

## Determinism

Same mailbox state in, byte-identical envelope set out, ids and ordering included. Mailboxes are
sorted by name, messages by uid; `received_at` and `referenceTime` are injected. There is no
clock on the envelope path. `occurred_at` comes from the message's own `Date`, falling back to
the server's INTERNALDATE only when that header is absent or unparseable — and to nothing at
all if there is neither, in which case no envelope exists.

## Hostile input

Mail is the most hostile input in the system: every byte was written by whoever sent the
message, including the parts that look like structure. `src/mime.ts` is a dependency-free
defensive reader — nothing throws, every structure is bounded, and duplicate singleton headers
(the observable signature of header injection) are recorded rather than silently resolved. See
`test/support/hostile.mjs` for the corpus the suite and the gate share.

Two rules are load-bearing and tested by name:

- **M-6** — `source`, `kind`, `persona`, `v`, `type` and both timestamps come from closed sets
  and from registration, never from the message. Injected text lands in `payload`, inertly.
- **M-12** — a display name is **not** an identity. Display name and address are separate
  payload fields; `actor.external_id` is always the address; every envelope carries
  `from_verification: "none"` because a mail connector observes at §1.6 level 0 and cannot prove
  otherwise; a homoglyph address is flagged and preserved verbatim, never normalized towards the
  address it imitates.

## Gate

`bash gates/gk-email.sh`
