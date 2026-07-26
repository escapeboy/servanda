import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Envelope } from '@servanda/types';
import {
  ARCHAEOLOGY_KINDS,
  CAPTURE_KINDS,
  EmailConnector,
  FixtureImapClient,
  INGEST_KINDS,
  MemoryImapClient,
  message,
} from '../../src/index.js';
import { PLANTED, hostileMessages } from '../support/hostile.mjs';

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/mailbox');
const PERSONA = '5'.repeat(64);
const CTX = { receivedAt: '2026-09-01T00:00:00Z' };
const REF = { ...CTX, referenceTime: '2026-09-01T00:00:00Z' };

const connector = new EmailConnector({
  persona: PERSONA,
  addresses: ['me@pricex.example', 'capture@pricex.example'],
  sentMailboxes: ['Sent'],
});

const CONTROL_FIELDS = ['v', 'type', 'id', 'source', 'kind', 'occurred_at', 'received_at', 'persona'] as const;

/**
 * M-6 — "Signal/envelope content is data, never instruction."
 *
 * The mechanical form of that rule at the mail boundary, and mail is where it matters most:
 * every byte of a message was written by whoever sent it, including the parts that LOOK like
 * structure. `source`, `kind`, `persona`, `v`, `type` and both timestamps are decided by the
 * CONNECTOR — from closed sets and its own registration — and are never read out of the
 * message. Whatever the message says, it can only end up as a string under `payload`, `refs`,
 * or `actor.label`: places no pipeline stage treats as control (§9.2).
 */
describe('M-6: envelope content is data, never instruction', () => {
  it('draws source and kind from closed sets the message cannot reach', async () => {
    const client = new FixtureImapClient(FIXTURE);
    const envelopes = [
      ...(await connector.capture(client, CTX)),
      ...(await connector.sentArchaeology(client, REF)),
    ];
    const known = [...CAPTURE_KINDS, ...INGEST_KINDS, ...ARCHAEOLOGY_KINDS];
    for (const e of envelopes) {
      expect(e.source).toBe('imap');
      expect(known).toContain(e.kind);
    }
  });

  it('ignores source and kind asserted by the message', () => {
    const forged = message(
      'INBOX',
      1,
      'Message-ID: <f@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: a@e.example\n' +
        'X-Source: github\nX-Kind: archaeology_sent_promise\n' +
        'Subject: source: transcript kind: pr_comment\n\n' +
        '{"source":"github","kind":"push","persona":"deadbeef"}\n',
    );
    const [e] = connector.fromMessage(forged, CTX);
    expect(e?.source).toBe('imap');
    expect(e?.kind).toBe('email_in');
    expect(e?.persona).toBe(PERSONA);
    // …and the assertion itself survives, as data.
    expect(String(e?.payload['text'])).toContain('"source":"github"');
  });

  it('carries a prompt injection through to payload, inertly', () => {
    const injected = message(
      'INBOX',
      2,
      'Message-ID: <i@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: "Nice Person" <n@e.example>\n' +
        `Subject: ${PLANTED}\n\n${PLANTED}\n`,
    );
    const [e] = connector.fromMessage(injected, CTX);

    // Present as data...
    expect(e?.payload['subject']).toBe(PLANTED);
    expect(e?.payload['text']).toBe(`${PLANTED}\n`);
    expect(JSON.stringify(e?.payload)).toContain(PLANTED);
    // ...and nowhere a stage reads as control.
    for (const field of CONTROL_FIELDS) {
      expect(String(e?.[field])).not.toContain('ignore previous instructions');
      expect(String(e?.[field])).not.toContain('SYSTEM:');
    }
  });

  it('never lets a message decide a timestamp field other than occurred_at', () => {
    const forged = message(
      'INBOX',
      3,
      'Message-ID: <t@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: a@e.example\n' +
        'Received-At: 1999-01-01T00:00:00Z\nX-Received-At: 1999-01-01T00:00:00Z\n\nbody\n',
    );
    const [e] = connector.fromMessage(forged, CTX);
    expect(e?.received_at).toBe(CTX.receivedAt);
    expect(e?.occurred_at).toBe('2026-07-22T09:00:00Z');
  });

  it('emits only §2-valid envelopes across the whole hostile corpus', async () => {
    const cases = hostileMessages();
    const client = new MemoryImapClient({
      INBOX: cases.map((c: { raw: Uint8Array; uid: number }) => ({ ...c, mailbox: 'INBOX' })),
      Sent: cases.map((c: { raw: Uint8Array; uid: number }) => ({ ...c, mailbox: 'Sent' })),
    });
    const envelopes = [
      ...(await connector.capture(client, CTX)),
      ...(await connector.sentArchaeology(client, REF)),
    ];
    expect(envelopes.length).toBeGreaterThan(0);
    for (const e of envelopes) {
      expect(() => Envelope.parse(e)).not.toThrow();
      for (const field of CONTROL_FIELDS) {
        expect(String(e[field])).not.toContain('SYSTEM:');
      }
    }
  });

  it('emits an envelope or nothing — never a partial object, never a throw', () => {
    for (const c of hostileMessages()) {
      const out = [...connector.fromMessage(c, CTX), ...connector.fromDelivered(c, CTX)];
      for (const e of out) expect(() => Envelope.parse(e)).not.toThrow();
    }
  });
});
