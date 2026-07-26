import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Envelope } from '@servanda/types';
import {
  ARCHAEOLOGY_KINDS,
  EmailConnector,
  FixtureImapClient,
  MemoryImapClient,
  candidates,
  message,
  ownProse,
} from '../src/index.js';

const FIXTURE = resolve(import.meta.dirname, '../fixtures/mailbox');
const PERSONA = 'a'.repeat(64);
const OPTIONS = { receivedAt: '2026-09-01T00:00:00Z', referenceTime: '2026-09-01T00:00:00Z' };

const connector = new EmailConnector({
  persona: PERSONA,
  addresses: ['me@pricex.example', 'capture@pricex.example'],
  sentMailboxes: ['Sent'],
});
const client = new FixtureImapClient(FIXTURE);

describe('sent-mail archaeology: the cold-start move', () => {
  it('finds exactly the planted promises and questions', async () => {
    const envelopes = await connector.sentArchaeology(client, OPTIONS);
    expect(
      envelopes.map((e) => [e.kind, e.payload['uid'], e.payload['candidate_text']]),
    ).toEqual([
      [
        'archaeology_sent_promise',
        1,
        'I will send the phase 1 delivery plan once you confirm the scope.',
      ],
      [
        'archaeology_sent_question',
        1,
        'Could you let me know by the end of next week whether the budget works?',
      ],
      ['archaeology_sent_question', 4, 'Any update on the offer from last week?'],
      ['archaeology_sent_promise', 5, "I'll have the revised deck to you by Friday."],
    ]);
  });

  it('says nothing about the messages that are not promises', async () => {
    const envelopes = await connector.sentArchaeology(client, OPTIONS);
    // 0002 is an invoice notice; 0003's only "I will" is inside quoted text from the other party.
    expect(envelopes.filter((e) => e.payload['uid'] === 2)).toEqual([]);
    expect(envelopes.filter((e) => e.payload['uid'] === 3)).toEqual([]);
  });

  it('never mines the INBOX — a promise in received mail is not yours (M-1)', async () => {
    const envelopes = await connector.sentArchaeology(client, OPTIONS);
    for (const e of envelopes) expect(e.payload['mailbox']).toBe('Sent');
  });

  it('emits only valid §2 envelopes from the closed kind set', async () => {
    for (const e of await connector.sentArchaeology(client, OPTIONS)) {
      expect(() => Envelope.parse(e)).not.toThrow();
      expect(ARCHAEOLOGY_KINDS).toContain(e.kind);
      expect(e.source).toBe('imap');
      expect(e.persona).toBe(PERSONA);
    }
  });

  it('reports awaiting_reply from mailbox state, and ages against the injected reference time', async () => {
    const envelopes = await connector.sentArchaeology(client, OPTIONS);
    const answered = envelopes.find((e) => e.payload['uid'] === 1);
    const unanswered = envelopes.find((e) => e.payload['uid'] === 5);

    // The offer thread has Georgi's reply in INBOX; the deck thread has nothing.
    expect(answered?.payload['awaiting_reply']).toBe(false);
    expect(unanswered?.payload['awaiting_reply']).toBe(true);

    // 2026-07-20 → 2026-09-01
    expect(unanswered?.payload['age_days']).toBe(42);
    expect(unanswered?.payload['reference_time']).toBe(OPTIONS.referenceTime);
  });

  it('is deterministic', async () => {
    const a = await connector.sentArchaeology(client, OPTIONS);
    const b = await connector.sentArchaeology(new FixtureImapClient(FIXTURE), OPTIONS);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('refuses a reference time that is not RFC 3339', async () => {
    await expect(
      connector.sentArchaeology(client, { ...OPTIONS, referenceTime: 'yesterday' }),
    ).rejects.toThrow(/RFC 3339/u);
  });

  it('emits an envelope, never a commitment or an expectation (§3.4 decides that, not this)', async () => {
    for (const e of await connector.sentArchaeology(client, OPTIONS)) {
      expect(e.type).toBe('envelope');
      expect(e.payload['intent']).toBeUndefined();
      expect(e.payload['owner']).toBeUndefined();
      expect(e.payload['owed_to']).toBeUndefined();
      expect(e.payload['expect']).toBeUndefined();
      expect(e.payload['confidence']).toBeUndefined();
    }
  });
});

describe('sent-mail archaeology: what counts as your own prose', () => {
  it('drops quoted lines and everything past a reply separator', () => {
    const prose = ownProse(
      'My own sentence here.\n\nOn Thu, 9 Jul 2026 at 15:02, Georgi wrote:\n> I will do the thing.\n',
    );
    expect(prose).toContain('My own sentence here.');
    expect(prose).not.toContain('I will do the thing');
  });

  it('drops everything past a forward separator', () => {
    const prose = ownProse(
      'Passing this along.\n---------- Forwarded message ----------\nI will pay next week.\n',
    );
    expect(prose).not.toContain('I will pay');
  });
});

describe('sent-mail archaeology: cue sets', () => {
  it('reads a sentence as at most one candidate, promise before question', () => {
    const found = candidates('I will send it, could you confirm the address?', 8);
    expect(found.map((c) => c.kind)).toEqual(['archaeology_sent_promise']);
  });

  it('ignores sentences too short to carry an intent', () => {
    expect(candidates('I will.', 8)).toEqual([]);
  });

  it('is bounded per message per kind', () => {
    const many = Array.from({ length: 50 }, (_, i) => `I will do task number ${i} soon.`).join(' ');
    expect(candidates(many, 8).length).toBe(8);
  });

  it('produces nothing from a mailbox with no sent folder', async () => {
    const inboxOnly = new MemoryImapClient({
      INBOX: [
        message(
          'INBOX',
          1,
          'Message-ID: <x@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: them@e.example\n\nI will pay you on Friday for sure.\n',
        ),
      ],
    });
    expect(await connector.sentArchaeology(inboxOnly, OPTIONS)).toEqual([]);
  });
});
