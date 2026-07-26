import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The IMAP client is an INJECTED INTERFACE, never a dependency of this package.
 *
 * Two reasons, both load-bearing:
 *
 *  1. **Testability without a server.** Everything in this package — the gate included — runs
 *     against `FixtureImapClient` (a directory of `.eml` files) or `MemoryImapClient`. No
 *     network, no credentials, no fixture server. GK proves the package cannot reach out at
 *     all, which is only true because the transport lives outside it.
 *  2. **The connector must not own the credential.** A hosted node runs mail connectors
 *     operator-side (ui-design.md, "hosted node = invisible infrastructure"); the OAuth token
 *     belongs to whatever holds the session, not to the envelope builder.
 *
 * A real implementation — `imapflow`, `node-imap`, a Gmail API shim — satisfies `ImapClient`
 * and is constructed by the caller. This package never learns what it is.
 */

/** One stored message, exactly as the mailbox holds it. */
export interface ImapMessageSource {
  /** IMAP mailbox name, e.g. `INBOX`, `Sent`. */
  readonly mailbox: string;
  /** IMAP UID. Unique within a mailbox; used for stable ordering and identity. */
  readonly uid: number;
  /** RFC 5322 bytes. Not a string: a mailbox contains messages that are not valid UTF-8. */
  readonly raw: Uint8Array;
  /** IMAP flags (`\Seen`, `\Answered`, …), if the transport reports them. */
  readonly flags?: readonly string[];
  /**
   * The server's INTERNALDATE, in RFC 3339. Used only as a fallback for `occurred_at` when
   * the message carries no usable `Date` header — it is server state, not message content.
   */
  readonly internalDate?: string;
}

export interface ImapClient {
  /** Mailbox names. Order is not trusted; the connector sorts. */
  listMailboxes(): Promise<readonly string[]>;
  /** Every message in `mailbox`. Order is not trusted; the connector sorts by uid. */
  fetchAll(mailbox: string): Promise<readonly ImapMessageSource[]>;
}

/**
 * A mailbox as a directory tree: `<root>/<mailbox>/<file>.eml`.
 *
 * UID comes from a leading integer in the filename (`0007-offer.eml` → 7) so a fixture can
 * pin UIDs explicitly; otherwise it is the 1-based position in sorted filename order. Both
 * rules are stable across filesystems, which is what the determinism requirement needs —
 * `readdirSync` order is not.
 */
export class FixtureImapClient implements ImapClient {
  constructor(private readonly root: string) {}

  async listMailboxes(): Promise<readonly string[]> {
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch {
      return [];
    }
    return entries
      .filter((e) => {
        try {
          return statSync(join(this.root, e)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  }

  async fetchAll(mailbox: string): Promise<readonly ImapMessageSource[]> {
    const dir = join(this.root, mailbox);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.eml')).sort();
    } catch {
      return [];
    }
    const out: ImapMessageSource[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      let raw: Buffer;
      try {
        raw = readFileSync(join(dir, file));
      } catch {
        continue; // an unreadable file is a missing message, never an error
      }
      const explicit = /^(\d+)/u.exec(file);
      out.push({
        mailbox,
        uid: explicit === null ? i + 1 : Number(explicit[1]),
        raw: new Uint8Array(raw),
      });
    }
    return out;
  }
}

/** An in-memory mailbox. Used by the hostile-input suites, which must not write 10 MB to disk. */
export class MemoryImapClient implements ImapClient {
  constructor(private readonly mailboxes: Readonly<Record<string, readonly ImapMessageSource[]>>) {}

  async listMailboxes(): Promise<readonly string[]> {
    return Object.keys(this.mailboxes).sort();
  }

  async fetchAll(mailbox: string): Promise<readonly ImapMessageSource[]> {
    return this.mailboxes[mailbox] ?? [];
  }
}

/** Convenience for building `MemoryImapClient` fixtures from strings. */
export function message(
  mailbox: string,
  uid: number,
  raw: string,
  extra: Omit<ImapMessageSource, 'mailbox' | 'uid' | 'raw'> = {},
): ImapMessageSource {
  return { mailbox, uid, raw: new TextEncoder().encode(raw), ...extra };
}
