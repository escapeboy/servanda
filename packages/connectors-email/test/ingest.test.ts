import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Envelope } from '@servanda/types';
import { EmailConnector, FixtureImapClient, INGEST_KINDS, message } from '../src/index.js';

const FIXTURE = resolve(import.meta.dirname, '../fixtures/mailbox');
const PERSONA = 'a'.repeat(64);
const CTX = { receivedAt: '2026-09-01T00:00:00Z' };

const connector = new EmailConnector({
  persona: PERSONA,
  addresses: ['me@pricex.example', 'capture@pricex.example'],
  sentMailboxes: ['Sent'],
});

async function fixtureMessage(mailbox: string, uid: number) {
  const all = await new FixtureImapClient(FIXTURE).fetchAll(mailbox);
  return all.find((m) => m.uid === uid)!;
}

describe('the BCC / forward gesture', () => {
  it('turns a forward into an envelope with the original preserved as payload', async () => {
    const [e] = connector.fromDelivered(await fixtureMessage('INBOX', 3), CTX);

    expect(e).toBeDefined();
    expect(() => Envelope.parse(e!)).not.toThrow();
    expect(INGEST_KINDS).toContain(e!.kind);
    expect(e!.kind).toBe('email_forwarded');
    expect(e!.payload['gesture']).toBe('forward');

    const original = e!.payload['original'] as Record<string, unknown>;
    expect(original['kind']).toBe('message/rfc822');
    expect(original['from_address']).toBe('georgi@skladco.example');
    expect(original['subject']).toBe('Cabling spec');
    expect(String(original['text'])).toContain('cabling spec before the site visit');
  });

  it('carries the original message id in refs, so a commitment can cite the thread', async () => {
    const [e] = connector.fromDelivered(await fixtureMessage('INBOX', 3), CTX);
    expect(e!.refs).toContainEqual({ kind: 'message', value: 'cabling-2026-07-28@skladco.example' });
  });

  it('records the gesture time, not the original message time', async () => {
    const [e] = connector.fromDelivered(await fixtureMessage('INBOX', 3), CTX);
    // The forward was sent 2026-08-03 09:00 +0300; the original is from 2026-07-28.
    expect(e!.occurred_at).toBe('2026-08-03T06:00:00Z');
    expect((e!.payload['original'] as Record<string, unknown>)['date']).toBe('2026-07-28T11:10:00Z');
  });

  it('recognises a BCC: delivered to the node but not named in To or Cc', async () => {
    const [e] = connector.fromDelivered(await fixtureMessage('INBOX', 4), CTX);
    expect(e!.kind).toBe('email_bcc');
    expect(e!.payload['gesture']).toBe('bcc');
    expect(e!.payload['delivered_to']).toEqual(['capture@pricex.example']);
    expect(e!.payload['original_source']).toBe('none');
  });

  it('is not a gesture when the node is named in To', () => {
    const plain = message(
      'INBOX',
      1,
      'Message-ID: <p@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\n' +
        'Delivered-To: me@pricex.example\nFrom: them@e.example\nTo: me@pricex.example\n\nhello\n',
    );
    expect(connector.fromDelivered(plain, CTX)).toEqual([]);
  });

  it('is not a gesture when the message went nowhere near the node address', () => {
    const other = message(
      'INBOX',
      2,
      'Message-ID: <q@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: a@e.example\nTo: b@e.example\n\nhi\n',
    );
    expect(connector.fromDelivered(other, CTX)).toEqual([]);
  });

  it('reads an inline forward as quoted prose, never as headers', () => {
    const inline = message(
      'INBOX',
      3,
      'Message-ID: <if@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\n' +
        'Delivered-To: capture@pricex.example\nFrom: "Ivan" <me@pricex.example>\nTo: capture@pricex.example\n' +
        'Subject: Fwd: Terms\n\n' +
        'See below.\n\n' +
        '---------- Forwarded message ----------\n' +
        'From: "Georgi Petrov" <georgi@skladco.example>\n' +
        'Date: Mon, 1 Jul 2026 08:00:00 +0000\n' +
        'Subject: Terms\n\n' +
        'We accept the terms.\n',
    );
    const [e] = connector.fromDelivered(inline, CTX);
    const original = e!.payload['original'] as Record<string, unknown>;

    expect(original['kind']).toBe('inline_quoted');
    // The pseudo-`From:` is kept as RAW prose. There is no `from_address` field on an inline
    // original, because there is no header there to parse — only text someone typed.
    expect(original['from_raw']).toBe('"Georgi Petrov" <georgi@skladco.example>');
    expect(original['from_address']).toBeUndefined();
    expect(String(original['text'])).toContain('We accept the terms.');

    // The actor is the OUTER sender, always.
    expect(e!.actor.external_id).toBe('me@pricex.example');
  });

  it('prefers the forward reading when a message is both forwarded and BCC-delivered', () => {
    const both = message(
      'INBOX',
      4,
      'Message-ID: <bf@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\n' +
        'Delivered-To: capture@pricex.example\nFrom: me@pricex.example\nTo: someone@e.example\n' +
        'Subject: Fwd: thing\n\nSee below.\n\nBegin forwarded message:\nFrom: x@y.example\n\nbody\n',
    );
    expect(connector.fromDelivered(both, CTX)[0]?.kind).toBe('email_forwarded');
  });

  it('accepts raw bytes with no mailbox behind them (the MDA hook path)', () => {
    const raw = new TextEncoder().encode(
      'Message-ID: <raw@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\n' +
        'Delivered-To: capture@pricex.example\nFrom: a@e.example\nTo: b@e.example\n\nbody\n',
    );
    const [e] = connector.fromRawDelivered(raw, CTX);
    expect(e?.kind).toBe('email_bcc');
    expect(e?.payload['mailbox']).toBe('INBOX');
  });
});
