import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { InboxRecord } from '@servanda/types';
import {
  INBOX_RECORD_LIFETIME_DAYS,
  hubsFor,
  inboxRecordCanonical,
  shouldRepublish,
  verifyInboxRecord,
} from '../../src/index.js';
import { persona } from '../support/fixture.js';

/**
 * M-17 — only the persona key may alter its own inbox record.
 *
 * The rule reads procedural and is not. A hub able to sign a record naming somebody else's
 * persona could rewrite that persona's `hubs` to a hub it controls, and every sender in the
 * network would route there, correctly, per the protocol. The signature check is the whole of
 * what makes "a hub cannot move its users" true rather than intended.
 *
 * The four `inbox-records.json` cases are replayed against `verifyInboxRecord` directly. Until
 * this file existed, the family was vendored and counted by gate G0 and replayed by nothing —
 * a green gate over an oracle nobody consulted.
 */
const VECTORS = 'vendor/vectors/addressing/inbox-records.json';

interface Suite {
  known_keys: { label: string; persona_id: string }[];
  cases: {
    name: string;
    record: Record<string, unknown>;
    canonical: string;
    expected: { accepted: boolean; rejection_reason: string | null; actual_signer: string | null };
  }[];
}

let suite: Suite;

beforeAll(() => {
  suite = JSON.parse(readFileSync(VECTORS, 'utf8')) as Suite;
});

const alice = persona(0);
const bob = persona(1);

describe('M-17: a record is believed only when its own persona signed it', () => {
  it('replays every case the oracle states', () => {
    expect(suite.cases).toHaveLength(4);
  });

  it('reaches the oracle’s verdict on every case, including which key signed a rejected one', () => {
    for (const c of suite.cases) {
      expect(verifyInboxRecord(c.record, suite.known_keys), c.name).toEqual(c.expected);
    }
  });

  it('signs over the bytes the oracle names, not merely over something that round-trips', () => {
    // Two implementations can both "verify" and still disagree about the preimage, at which point
    // neither can read the other's records. The oracle pins the canonical string; so does this.
    for (const c of suite.cases) {
      expect(inboxRecordCanonical(InboxRecord.parse(c.record)), c.name).toBe(c.canonical);
    }
  });

  it('rejects a hub-signed record even with no idea whose key signed it', () => {
    // `known_keys` is a diagnostic. A verifier that cannot name the signer must still refuse —
    // "I don't recognise this key" is not a reason to accept a record.
    const hijack = suite.cases.find((c) => c.expected.rejection_reason === 'signer-is-not-the-persona')!;
    expect(verifyInboxRecord(hijack.record)).toEqual({
      accepted: false,
      rejection_reason: 'invalid-signature',
      actual_signer: null,
    });
  });

  it('a hub cannot move a user by re-signing the record it was given', () => {
    // The attack in full, run rather than described: take a valid record, point it at a hub of
    // our choosing, sign it with a key that is not the persona's, and offer it.
    const honest = withSignature(
      {
        v: 'servanda/0.1' as const,
        type: 'inbox' as const,
        persona: alice.personaId,
        hubs: ['https://hub.example/servanda'],
        issued_at: '2026-07-25T09:00:00Z',
      },
      alice.privateKey,
    );
    expect(verifyInboxRecord(honest).accepted).toBe(true);

    const moved = withSignature({ ...honest, hubs: ['https://hub.attacker.example/servanda'] }, bob.privateKey);
    const verdict = verifyInboxRecord(moved, [{ label: 'bob', persona_id: bob.personaId }]);
    expect(verdict).toEqual({
      accepted: false,
      rejection_reason: 'signer-is-not-the-persona',
      actual_signer: 'bob',
    });

    // And the honest record is untouched by the attempt: rejection is not a downgrade.
    expect(hubsFor(InboxRecord.parse(honest), '2026-07-26T09:00:00Z')).toEqual([
      'https://hub.example/servanda',
    ]);
  });
});

describe('§6.7: what a verified record then authorizes', () => {
  const record = () =>
    InboxRecord.parse(
      withSignature(
        {
          v: 'servanda/0.1' as const,
          type: 'inbox' as const,
          persona: alice.personaId,
          hubs: ['https://first.example/servanda', 'https://second.example/servanda'],
          issued_at: '2026-07-25T09:00:00Z',
        },
        alice.privateKey,
      ),
    );

  it('hands back the declared order, unsorted and unreordered', () => {
    // §6.7: a sender "MUST NOT reorder the list by its own measurements". The order is the
    // persona's statement about where it wants its mail; a sender that quietly puts the faster
    // hub first has overridden that choice without telling anyone.
    expect(hubsFor(record(), '2026-07-26T09:00:00Z')).toEqual([
      'https://first.example/servanda',
      'https://second.example/servanda',
    ]);
  });

  it('routes nowhere once the record has expired', () => {
    const day = (n: number) => new Date(Date.parse('2026-07-25T09:00:00Z') + n * 86_400_000).toISOString();
    expect(hubsFor(record(), day(INBOX_RECORD_LIFETIME_DAYS - 1))).toHaveLength(2);
    expect(hubsFor(record(), day(INBOX_RECORD_LIFETIME_DAYS + 1))).toEqual([]);
    // An expired record still VERIFIES — it was validly signed. Expiry is about routing, not
    // about authorship, and collapsing the two would report a stale record as a forged one.
    expect(verifyInboxRecord(record()).accepted).toBe(true);
  });

  it('asks for republication at half-life, well before anything expires', () => {
    const day = (n: number) => new Date(Date.parse('2026-07-25T09:00:00Z') + n * 86_400_000).toISOString();
    expect(shouldRepublish(record(), day(14))).toBe(false);
    expect(shouldRepublish(record(), day(16))).toBe(true);
    // The point of the half-life: a refreshed record is in circulation while the old one is
    // still routable, so there is no window in which a persona is unaddressable.
    expect(hubsFor(record(), day(16))).toHaveLength(2);
  });
});
