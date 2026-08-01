import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { InboxRecord } from '@servanda/types';
import { MemoryHub } from '../../src/hub.js';
import { HubClient, NoRecipientKey, hubFetch } from '../../src/hub-transport.js';
import {
  INBOX_RECORD_LIFETIME_DAYS,
  deliverViaInbox,
  dhKeyFrom,
  hubsFor,
  signMessage,
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
        v: 'servanda/0.2' as const,
        type: 'inbox' as const,
        persona: alice.personaId,
        hubs: ['https://hub.example/servanda'],
        dh_key: alice.dhPublicKey,
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
          v: 'servanda/0.2' as const,
          type: 'inbox' as const,
          persona: alice.personaId,
          hubs: ['https://first.example/servanda', 'https://second.example/servanda'],
          dh_key: alice.dhPublicKey,
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

  it('routes nowhere before the record has been issued', () => {
    // The 30-day lifetime is what bounds how long one signed statement keeps steering a
    // persona's mail — and which X25519 key §6.3 seals to. Enforcing only the far end left the
    // near end open: a record dated 3000-01-01 has an age below the limit at every instant a
    // sender will ever evaluate it at, so it routes for ever and never reaches the republish
    // half-life that would replace it. Anyone who holds the persona key for one moment can mint
    // one, and it outlives the compromise. "Valid for 30 days FROM issued_at" has two ends.
    const forever = InboxRecord.parse(
      withSignature(
        {
          v: 'servanda/0.2' as const,
          type: 'inbox' as const,
          persona: alice.personaId,
          hubs: ['https://attacker.example/servanda'],
          dh_key: alice.dhPublicKey,
          issued_at: '3000-01-01T00:00:00Z',
        },
        alice.privateKey,
      ),
    );
    expect(hubsFor(forever, '2026-07-26T09:00:00Z')).toEqual([]);
    // …and therefore no sealing key comes out of it either (§6.3 joins here).
    expect(dhKeyFrom(forever, '2026-07-26T09:00:00Z')).toBeNull();
    // It is not a forgery, though: it verifies. Only its window is wrong.
    expect(verifyInboxRecord(forever).accepted).toBe(true);
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

/**
 * §6.7 store-and-forward, which is where a verified record finally does something.
 *
 * The failure mode being guarded is not "delivery failed" — §6.7 says plainly that delivery is
 * optimization and reconciliation is the guarantee, so a dropped message is expected and healed.
 * What must not happen is a sender quietly substituting its own judgement for the persona's:
 * reordering the hubs by latency, routing on a record it never verified, or honouring one whose
 * owner has moved on.
 */
describe('§6.7: delivering to declared hubs, in the declared order', () => {
  const ISSUED = '2026-07-25T09:00:00Z';
  const DAY = (n: number) => new Date(Date.parse(ISSUED) + n * 86_400_000).toISOString();
  const HUBS = ['https://first.example', 'https://second.example', 'https://third.example'];

  const signedRecord = (by: { personaId: string; privateKey: string }, persona = alice.personaId) =>
    withSignature(
      { v: 'servanda/0.2' as const, type: 'inbox' as const, persona, hubs: HUBS, dh_key: alice.dhPublicKey, issued_at: ISSUED },
      by.privateKey,
    );

  const message = () =>
    signMessage('propose', { hello: 'world' }, alice.personaId, bob.personaId, ISSUED, alice.privateKey);

  /** Records what was tried, in order, and fails whichever hubs the caller names. */
  function courier(failing: readonly string[]) {
    const tried: string[] = [];
    return {
      tried,
      clientFor: (baseUrl: string) => ({
        async send() {
          tried.push(baseUrl);
          if (failing.includes(baseUrl)) throw new Error(`hub refused delivery: HTTP 503`);
        },
      }),
    };
  }

  it('stops at the first hub that accepts, and tries no other', async () => {
    const c = courier([]);
    const out = await deliverViaInbox({
      record: signedRecord(alice), now: DAY(1), recipient: bob.personaId, message: message(), clientFor: c.clientFor,
    });
    expect(out).toEqual({ delivered: HUBS[0], attempts: [], refused: null });
    expect(c.tried).toEqual([HUBS[0]]);
  });

  it('walks the list in the declared order when a hub is down', async () => {
    const c = courier([HUBS[0]!, HUBS[1]!]);
    const out = await deliverViaInbox({
      record: signedRecord(alice), now: DAY(1), recipient: bob.personaId, message: message(), clientFor: c.clientFor,
    });
    expect(c.tried).toEqual(HUBS);
    expect(out.delivered).toBe(HUBS[2]);
    expect(out.attempts.map((a) => a.hub)).toEqual([HUBS[0], HUBS[1]]);
  });

  it('every hub failing is an outcome, not an exception', async () => {
    // §6.7: "Delivery is optimization; reconciliation is the guarantee." A caller forced to catch
    // would be pushed toward treating a hub as durable, and a hub queues with a TTL and may drop.
    const c = courier(HUBS);
    const out = await deliverViaInbox({
      record: signedRecord(alice), now: DAY(1), recipient: bob.personaId, message: message(), clientFor: c.clientFor,
    });
    expect(out.delivered).toBeNull();
    expect(out.refused).toBeNull();
    expect(out.attempts).toHaveLength(3);
  });

  it('routes nowhere on a record it has not verified — M-17, one layer up', async () => {
    const c = courier([]);
    const out = await deliverViaInbox({
      record: signedRecord(bob), now: DAY(1), recipient: bob.personaId, message: message(), clientFor: c.clientFor,
    });
    // `invalid-signature`, not `signer-is-not-the-persona`: routing passes no candidate keys,
    // because which key signed is a diagnostic and refusing does not depend on naming it. The
    // sender needs one fact — it was not the persona's — and it has that.
    expect(out.refused).toBe('invalid-signature');
    // Nothing was attempted at all. A sender that tried the attacker's hub and only then noticed
    // has already delivered to it.
    expect(c.tried).toEqual([]);
  });

  it('routes nowhere on an expired record', async () => {
    const c = courier([]);
    const out = await deliverViaInbox({
      record: signedRecord(alice),
      now: DAY(INBOX_RECORD_LIFETIME_DAYS + 1),
      recipient: bob.personaId,
      message: message(),
      clientFor: c.clientFor,
    });
    expect(out.refused).toBe('record-expired');
    expect(c.tried).toEqual([]);
  });
});

/**
 * §6.3 sealing keys, and the rule that a published key is worth nothing unverified.
 *
 * This is where M-17 stops being about addressing and starts being about confidentiality. A hub
 * that could publish an inbox record could publish a `dh_key` it holds the private half of — and
 * then read everything sent to that persona. Same attack as `invalid-signed-by-hub`, one layer
 * along: not moving someone's mail, reading it.
 *
 * Upstream #33 proposes the field; until it is merged the vendored vectors predate it, so a record
 * without one still parses and still verifies over exactly the canonical form the oracle pins.
 * What it cannot do is receive anything.
 */
describe('§6.3: a sealing key is only usable from a record that verifies', () => {
  const ISSUED = '2026-07-25T09:00:00Z';
  const DAY = (n: number) => new Date(Date.parse(ISSUED) + n * 86_400_000).toISOString();

  const record = (by: { privateKey: string }, over: Record<string, unknown> = {}) =>
    withSignature(
      {
        v: 'servanda/0.2' as const,
        type: 'inbox' as const,
        persona: alice.personaId,
        hubs: ['https://hub.example'],
        dh_key: alice.dhPublicKey,
        issued_at: ISSUED,
        ...over,
      },
      by.privateKey,
    );

  it('hands back the key from a record the persona signed', () => {
    expect(dhKeyFrom(record(alice), DAY(1))).toBe(alice.dhPublicKey);
  });

  it('hands back nothing from a record a hub signed', () => {
    // The attack in full: bob publishes a record naming alice and carrying a key bob controls.
    const hijack = record(bob, { dh_key: bob.dhPublicKey });
    expect(dhKeyFrom(hijack, DAY(1))).toBeNull();
  });

  it('hands back nothing once the record has expired', () => {
    // Expiry governs where a persona wants its mail; a key from a record its owner let lapse is
    // no better an answer than a hub they have left.
    expect(dhKeyFrom(record(alice), DAY(INBOX_RECORD_LIFETIME_DAYS + 1))).toBeNull();
  });

  it('refuses a record with no dh_key at all', () => {
    // `dh_key` was optional while upstream #33 was a proposal and the vendored vectors predated
    // it. It is merged and required now, so a record without one is malformed rather than merely
    // unsealable — and `verifyInboxRecord` says so instead of reporting a signature problem.
    const { dh_key: _omitted, ...withoutKey } = record(alice);
    const resigned = withSignature(withoutKey, alice.privateKey);
    expect(verifyInboxRecord(resigned)).toEqual({
      accepted: false,
      rejection_reason: 'malformed-record',
      actual_signer: null,
    });
    expect(dhKeyFrom(resigned, DAY(1))).toBeNull();
  });

  it('a node with no key for the recipient refuses to send rather than falling back', () => {
    // R5. There is no path from a persona_id to a sealing key any more, so this is not a check
    // someone remembered to write — it is the only thing the transport can do.
    const hub = new MemoryHub({ now: () => new Date(DAY(1)) });
    const client = new HubClient({
      baseUrl: 'https://hub.example',
      persona: alice.personaId,
      privateKey: alice.privateKey,
      dhPrivateKey: alice.dhPrivateKey,
      fetch: hubFetch(hub),
      resolveDhKey: () => null,
      now: () => new Date(DAY(1)),
    });
    expect(() => client.sealFor(bob.personaId, signMessage('propose', {}, alice.personaId, bob.personaId, ISSUED, alice.privateKey)))
      .toThrow(NoRecipientKey);
    expect(hub.visibleState()).toHaveLength(0);
  });
});
