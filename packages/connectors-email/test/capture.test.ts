import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Envelope } from '@servanda/types';
import { CAPTURE_KINDS, EmailConnector, FixtureImapClient, message, MemoryImapClient } from '../src/index.js';

const FIXTURE = resolve(import.meta.dirname, '../fixtures/mailbox');
const PERSONA = 'a'.repeat(64);
const CTX = { receivedAt: '2026-09-01T00:00:00Z' };

const connector = new EmailConnector({
  persona: PERSONA,
  addresses: ['me@pricex.example', 'capture@pricex.example'],
  sentMailboxes: ['Sent'],
});
const client = new FixtureImapClient(FIXTURE);

describe('capture: the fixture mailbox', () => {
  it('emits one envelope per message, all valid against §2', async () => {
    const envelopes = await connector.capture(client, CTX);
    expect(envelopes.length).toBe(9);
    for (const e of envelopes) {
      expect(() => Envelope.parse(e)).not.toThrow();
      expect(e.source).toBe('imap');
      expect(CAPTURE_KINDS).toContain(e.kind);
      expect(e.persona).toBe(PERSONA);
      expect(e.received_at).toBe(CTX.receivedAt);
    }
  });

  it('is deterministic: same mailbox state, same envelopes in the same order', async () => {
    const a = await connector.capture(client, CTX);
    const b = await new EmailConnector({
      persona: PERSONA,
      addresses: ['me@pricex.example', 'capture@pricex.example'],
      sentMailboxes: ['Sent'],
    }).capture(new FixtureImapClient(FIXTURE), CTX);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('orders by mailbox name then uid, not by the transport answer order', async () => {
    const shuffled = new MemoryImapClient({
      Sent: [
        message('Sent', 3, 'Message-ID: <c@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: me@pricex.example\n\nc\n'),
        message('Sent', 1, 'Message-ID: <a@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: me@pricex.example\n\na\n'),
        message('Sent', 2, 'Message-ID: <b@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: me@pricex.example\n\nb\n'),
      ],
    });
    const envelopes = await connector.capture(shuffled, CTX);
    expect(envelopes.map((e) => e.payload['uid'])).toEqual([1, 2, 3]);
  });

  it('takes occurred_at from the message Date, never from the wall clock', async () => {
    const envelopes = await connector.capture(client, CTX);
    const offer = envelopes.find((e) => e.payload['message_id'] === 'offer-2026-07-22@pricex.example');
    // Wed, 22 Jul 2026 09:14:00 +0300
    expect(offer?.occurred_at).toBe('2026-07-22T06:14:00Z');
  });

  it('falls back to the server INTERNALDATE only when the message has no usable Date', () => {
    const noDate = message('INBOX', 1, 'Message-ID: <nd@e>\nFrom: x@e.example\n\nbody\n', {
      internalDate: '2026-08-09T10:00:00Z',
    });
    expect(connector.fromMessage(noDate, CTX)[0]?.occurred_at).toBe('2026-08-09T10:00:00Z');

    const nothing = message('INBOX', 2, 'Message-ID: <nn@e>\nFrom: x@e.example\n\nbody\n');
    expect(connector.fromMessage(nothing, CTX)).toEqual([]);
  });
});

describe('capture: direction', () => {
  it('trusts the mailbox before the From header', () => {
    const forged = message(
      'Sent',
      1,
      'Message-ID: <f@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: stranger@evil.example\n\nx\n',
    );
    const [e] = connector.fromMessage(forged, CTX);
    expect(e?.kind).toBe('email_out');
    expect(e?.payload['direction_basis']).toBe('mailbox');
  });

  it('falls back to the From header, and says so', () => {
    const own = message(
      'Archive',
      1,
      'Message-ID: <o@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: me@pricex.example\n\nx\n',
    );
    expect(connector.fromMessage(own, CTX)[0]?.payload['direction_basis']).toBe('from_header');
  });

  it('defaults to inbound', () => {
    const other = message(
      'Archive',
      2,
      'Message-ID: <p@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: someone@else.example\n\nx\n',
    );
    const [e] = connector.fromMessage(other, CTX);
    expect(e?.kind).toBe('email_in');
    expect(e?.payload['direction_basis']).toBe('default');
  });
});

describe('capture: reply as evidence (scenario 3)', () => {
  it('carries the thread reference in refs so a commitment can cite it later', async () => {
    const envelopes = await connector.capture(client, CTX);
    const reply = envelopes.find((e) => e.payload['message_id'] === 'reply-2026-08-02@skladco.example');

    expect(reply?.payload['is_reply']).toBe(true);
    expect(reply?.payload['in_reply_to']).toBe('offer-2026-07-22@pricex.example');
    expect(reply?.payload['thread_id']).toBe('offer-2026-07-22@pricex.example');
    expect(reply?.refs).toEqual([
      { kind: 'message', value: 'reply-2026-08-02@skladco.example' },
      { kind: 'message', value: 'offer-2026-07-22@pricex.example' },
    ]);
  });

  it('gives the reply and the message it answers the same thread id', async () => {
    const envelopes = await connector.capture(client, CTX);
    const offer = envelopes.find((e) => e.payload['message_id'] === 'offer-2026-07-22@pricex.example');
    const reply = envelopes.find((e) => e.payload['message_id'] === 'reply-2026-08-02@skladco.example');
    expect(offer?.payload['thread_id']).toBe(reply?.payload['thread_id']);
  });

  it('gives a message with no ids at all no thread id rather than a made-up one', () => {
    const orphan = message(
      'INBOX',
      9,
      'Date: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: x@e.example\n\nbody\n',
    );
    const [e] = connector.fromMessage(orphan, CTX);
    expect(e?.payload['thread_id']).toBeUndefined();
    expect(e?.refs).toEqual([]);
  });
});
