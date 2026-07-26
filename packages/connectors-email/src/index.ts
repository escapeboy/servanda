import { PersonaId } from '@servanda/types';
import type { Envelope } from '@servanda/types';
import type { CaptureContext, EmailIdentity } from './capture.js';
import { envelopeFromMessage, normalizeIdentity } from './capture.js';
import type { ImapClient, ImapMessageSource } from './imap.js';
import type { IngestOptions } from './ingest.js';
import { envelopeFromDelivered, envelopeFromRawDelivered } from './ingest.js';
import type { SentArchaeologyOptions } from './archaeology.js';
import { sentArchaeologyEnvelopes, sortSources } from './archaeology.js';

export * from './archaeology.js';
export * from './capture.js';
export * from './envelope.js';
export * from './imap.js';
export * from './ingest.js';
export * from './mime.js';

export interface EmailConnectorOptions {
  readonly persona: string;
  /** The node's own mail addresses. Registration data, not something a message may assert. */
  readonly addresses?: readonly string[];
  /** Mailboxes that hold sent mail. Defaults to the three names IMAP servers actually use. */
  readonly sentMailboxes?: readonly string[];
}

export interface CaptureOptions extends CaptureContext {
  /** Restrict the sweep. Omitted → every mailbox the client reports, in sorted order. */
  readonly mailboxes?: readonly string[];
}

/**
 * §2 / M-5: "a connector instance is bound to exactly one persona at registration."
 *
 * The persona is a constructor argument and never a method argument. Reading two mailboxes for
 * two org personas requires two connectors, which is exactly the separation M-5 demands — and
 * the node's own addresses are bound at the same moment, so no message can talk the connector
 * into believing it was addressed to someone it is not.
 */
export class EmailConnector {
  readonly persona: string;
  readonly identity: EmailIdentity;

  constructor(options: EmailConnectorOptions) {
    this.persona = PersonaId.parse(options.persona);
    this.identity = normalizeIdentity(options);
  }

  /** One stored message → zero or one `email_in` / `email_out` envelope. */
  fromMessage(source: ImapMessageSource, ctx: CaptureContext): Envelope[] {
    const envelope = envelopeFromMessage(source, this.persona, this.identity, ctx);
    return envelope === undefined ? [] : [envelope];
  }

  /**
   * Sweep mailboxes into envelopes. Mailboxes sorted by name, messages by uid — the emitted
   * set is a function of mailbox STATE, never of the order the transport happened to answer in.
   */
  async capture(client: ImapClient, ctx: CaptureOptions): Promise<Envelope[]> {
    const all = [...(await client.listMailboxes())].sort();
    const wanted = ctx.mailboxes === undefined ? all : all.filter((m) => ctx.mailboxes!.includes(m));
    const out: Envelope[] = [];
    for (const mailbox of wanted) {
      for (const source of sortSources(await client.fetchAll(mailbox))) {
        const envelope = envelopeFromMessage(source, this.persona, this.identity, ctx);
        if (envelope !== undefined) out.push(envelope);
      }
    }
    return out;
  }

  /** Sent-mail archaeology: promises made and answers awaited, from the Sent folder. */
  async sentArchaeology(client: ImapClient, options: SentArchaeologyOptions): Promise<Envelope[]> {
    return sentArchaeologyEnvelopes(client, this.persona, this.identity, options);
  }

  /** The BCC/forward gesture, from a stored message. Zero or one envelope. */
  fromDelivered(source: ImapMessageSource, ctx: IngestOptions): Envelope[] {
    const envelope = envelopeFromDelivered(source, this.persona, this.identity, ctx);
    return envelope === undefined ? [] : [envelope];
  }

  /** The BCC/forward gesture, from raw bytes handed over by an MDA hook. */
  fromRawDelivered(
    raw: Uint8Array,
    ctx: IngestOptions & { readonly mailbox?: string; readonly uid?: number },
  ): Envelope[] {
    const envelope = envelopeFromRawDelivered(raw, this.persona, this.identity, ctx);
    return envelope === undefined ? [] : [envelope];
  }
}
