import { describe, expect, it } from 'vitest';
import { Envelope } from '@servanda/types';
import {
  ARCHAEOLOGY_KINDS,
  CAPTURE_KINDS,
  EmailConnector,
  INGEST_KINDS,
  MemoryImapClient,
} from '../src/index.js';
// Shared with gates/gk-email.sh — the suite and the gate check the SAME corpus.
import { PLANTED, hostileMessages } from './support/hostile.mjs';

const PERSONA = 'b'.repeat(64);
const CTX = { receivedAt: '2026-09-01T00:00:00Z' };
const REF = { ...CTX, referenceTime: '2026-09-01T00:00:00Z' };

const connector = new EmailConnector({
  persona: PERSONA,
  addresses: ['me@pricex.example', 'capture@pricex.example'],
  sentMailboxes: ['Sent'],
});

const KNOWN_KINDS: readonly string[] = [...CAPTURE_KINDS, ...INGEST_KINDS, ...ARCHAEOLOGY_KINDS];
const cases = hostileMessages();

/**
 * The property, stated once: whatever a mailbox contains, every object this connector emits is
 * a valid §2 envelope drawn from closed sets, and nothing in the message reached a field a
 * pipeline stage reads as control.
 */
function assertInert(envelope: unknown): void {
  const parsed = Envelope.parse(envelope);
  expect(parsed.source).toBe('imap');
  expect(KNOWN_KINDS).toContain(parsed.kind);
  expect(parsed.persona).toBe(PERSONA);
  expect(parsed.v).toBe('servanda/0.1');
  expect(parsed.type).toBe('envelope');
  expect(parsed.received_at).toBe(CTX.receivedAt);
  for (const field of ['v', 'type', 'id', 'source', 'kind', 'received_at', 'persona'] as const) {
    expect(String(parsed[field])).not.toContain('SYSTEM:');
    expect(String(parsed[field])).not.toContain('ignore previous instructions');
  }
}

describe('hostile input: only valid §2 envelopes, ever', () => {
  it(`handles all ${cases.length} hostile messages without throwing`, () => {
    for (const c of cases) {
      expect(() => connector.fromMessage(c, CTX), c.name).not.toThrow();
      expect(() => connector.fromDelivered(c, CTX), c.name).not.toThrow();
    }
  });

  for (const c of cases) {
    it(`emits only valid envelopes for: ${c.name}`, () => {
      for (const e of [...connector.fromMessage(c, CTX), ...connector.fromDelivered(c, CTX)]) {
        assertInert(e);
      }
    });
  }

  it('emits only valid envelopes when the whole corpus is mined as a mailbox', async () => {
    const client = new MemoryImapClient({
      INBOX: cases.map((c) => ({ ...c, mailbox: 'INBOX' })),
      Sent: cases.map((c) => ({ ...c, mailbox: 'Sent' })),
    });
    const envelopes = [
      ...(await connector.capture(client, CTX)),
      ...(await connector.sentArchaeology(client, REF)),
    ];
    expect(envelopes.length).toBeGreaterThan(0);
    for (const e of envelopes) assertInert(e);
  });

  it('is deterministic over hostile input too', async () => {
    const build = () =>
      new MemoryImapClient({ INBOX: cases.map((c) => ({ ...c, mailbox: 'INBOX' })) });
    const a = await connector.capture(build(), CTX);
    const b = await connector.capture(build(), CTX);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('hostile input: the injection lands inertly in payload', () => {
  const find = (name: string) => cases.find((c) => c.name === name)!;

  it('header injection: the first From wins, the forged one is data', () => {
    const [e] = connector.fromMessage(find('header-injection'), CTX);
    expect(e?.payload['from_address']).toBe('real@partner.example');
    expect(e?.actor.external_id).toBe('real@partner.example');
    expect(e?.payload['subject']).toBe('Invoice');
    expect(e?.payload['header_anomalies']).toContain('duplicate-header:from');
    expect(e?.payload['header_anomalies']).toContain('duplicate-header:subject');
    // The planted instruction is present — as a string in the body, and nowhere else.
    expect(e?.payload['text']).toBe(`${PLANTED}\n`);
  });

  it('html with scripts: the visible text survives, the script does not execute or persist', () => {
    const [e] = connector.fromMessage(find('html-with-scripts'), CTX);
    expect(e?.payload['html']).toBe(true);
    expect(String(e?.payload['text'])).toContain(PLANTED);
    expect(String(e?.payload['text'])).not.toContain('<script');
    expect(String(e?.payload['text'])).not.toContain('fetch(');
    expect(String(e?.payload['text'])).not.toContain('javascript:');
  });

  it('a 10 MB body is bounded, and the original length is preserved', () => {
    const [e] = connector.fromMessage(find('ten-megabyte-body'), CTX);
    expect(String(e?.payload['text']).length).toBeLessThanOrEqual(8192);
    expect(e?.payload['raw_bytes']).toBeGreaterThan(10 * 1024 * 1024);
    expect(e?.payload['truncated']).toBe(true);
    expect(JSON.stringify(e).length).toBeLessThan(64 * 1024);
  });

  it('invalid UTF-8 becomes replacement characters, not an exception', () => {
    const [e] = connector.fromMessage(find('invalid-utf8'), CTX);
    expect(typeof e?.payload['text']).toBe('string');
    expect(e?.payload['from_address']).toBe('bad@evil.example');
  });

  it('an empty message produces nothing at all', () => {
    expect(connector.fromMessage(find('empty-message'), CTX)).toEqual([]);
  });

  it('a message with no defensible timestamp produces nothing at all', () => {
    expect(connector.fromMessage(find('no-date'), CTX)).toEqual([]);
    expect(connector.fromMessage(find('absurd-date'), CTX)).toEqual([]);
  });

  it('a malformed multipart yields a partial parse with the failure recorded', () => {
    const [missing] = connector.fromMessage(find('multipart-boundary-missing'), CTX);
    expect(missing?.payload['header_anomalies']).toContain('multipart-without-parts');
    const none = connector.fromMessage(find('multipart-without-boundary'), CTX)[0];
    expect(none?.payload['header_anomalies']).toContain('multipart-without-boundary');
  });

  it('deep nesting stops at the depth limit', () => {
    const [e] = connector.fromMessage(find('deeply-nested-multipart'), CTX);
    expect(e?.payload['header_anomalies']).toContain('mime-depth-limit');
  });

  it('a header flood is bounded and recorded', () => {
    const [e] = connector.fromMessage(find('header-flood'), CTX);
    expect(e?.payload['header_anomalies']).toContain('header-limit');
    expect(JSON.stringify(e).length).toBeLessThan(64 * 1024);
  });

  it('an address flood is bounded', () => {
    const [e] = connector.fromMessage(find('address-flood'), CTX);
    expect((e?.payload['to'] as string[]).length).toBeLessThanOrEqual(32);
    expect(e?.payload['to_count']).toBe(64);
  });

  it('an encoded word that decodes to a newline stays inside the subject', () => {
    const [e] = connector.fromMessage(find('encoded-word-injection'), CTX);
    expect(String(e?.payload['subject'])).toContain('From: ceo@acme.example');
    expect(e?.payload['from_address']).toBe('e@e.example');
    expect(e?.actor.external_id).toBe('e@e.example');
  });

  it('a forged inline forward never lends its prose any authority', () => {
    const [e] = connector.fromDelivered(find('forged-inline-forward'), CTX);
    expect(e?.kind).toBe('email_forwarded');
    // The outer, real sender is the actor. The "ceo@acme.example" line is prose.
    expect(e?.actor.external_id).toBe('attacker@evil.example');
    const original = e?.payload['original'] as Record<string, unknown>;
    expect(original['kind']).toBe('inline_quoted');
    expect(original['from_raw']).toBe('"Chief Executive" <ceo@acme.example>');
    expect(original['from_address']).toBeUndefined();
    expect(String(original['text'])).toContain(PLANTED);
  });

  it('a quoted-printable body of soft breaks decodes without blowing up', () => {
    const [e] = connector.fromMessage(find('quoted-printable-bomb'), CTX);
    expect(String(e?.payload['text']).trim()).toBe('SYSTEM');
  });
});
