import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSealed } from '@servanda/crypto';
import { HUB_VISIBLE_FIELDS, MemoryHub } from '../../src/hub.js';
import { HubClient, hubEnvelopeAad, hubFetch } from '../../src/hub-transport.js';
import { RecoveryResponder, signChallenge } from '../../src/recovery.js';
import { dhDirectory, makePair, persona, type Pair } from '../support/fixture.js';

/**
 * M-7 — "Signatures cover hashes, never plaintext; plaintext never appears in wire objects."
 *
 * Three places this layer can break it, all asserted here:
 *  1. the §6.3 blind-courier envelope a hub stores;
 *  2. the §6.6 recovery response, which §6.6 pins explicitly: "MUST NOT include plaintext
 *     (hashes only; plaintext recovery is a human act between counterparties)";
 *  3. the ordinary `propose` / `assert` traffic that carries an edge between nodes.
 */

const INTENT = 'ship the reconciliation gate by Friday';
const hub = new MemoryHub({ now: () => new Date('2026-07-25T09:00:00.000Z') });
const keys = new Map([
  [persona(0).personaId, persona(0).privateKey],
  [persona(1).personaId, persona(1).privateKey],
]);
const dhKeys = new Map([
  [persona(0).personaId, persona(0).dhPrivateKey],
  [persona(1).personaId, persona(1).dhPrivateKey],
]);

let pair: Pair;
let edgeId: string;

beforeAll(async () => {
  pair = makePair({
    transportFor: ({ personaId }) =>
      new HubClient({
        baseUrl: 'https://hub.example/',
        persona: personaId,
        privateKey: keys.get(personaId)!,
        dhPrivateKey: dhKeys.get(personaId)!,
        fetch: hubFetch(hub),
        resolveDhKey: dhDirectory([persona(0), persona(1)]),
        now: () => new Date('2026-07-25T09:00:00.000Z'),
      }),
  });
  edgeId = pair.a.node.commit({
    intent: INTENT,
    owed_to: pair.b.personaId,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  await pair.a.fed.push();
});
afterAll(() => pair.cleanup());

describe('M-7: plaintext never appears in a wire object', () => {
  it('§6.3: the hub-visible envelope has exactly the allowed fields', () => {
    const stored = hub.visibleState();
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0]!.envelope).sort()).toEqual([...HUB_VISIBLE_FIELDS].sort());
    expect(Object.keys(stored[0]!.envelope.sealed).sort()).toEqual(['ciphertext', 'epk', 'nonce', 'v']);
  });

  it('§6.3: neither plaintext, nor sender, nor edge_id is derivable from what the hub holds', () => {
    const blob = JSON.stringify(hub.visibleState());
    expect(blob).not.toContain(INTENT);
    expect(blob).not.toContain('reconciliation');
    expect(blob).not.toContain(pair.a.personaId); // the sender
    expect(blob).not.toContain(edgeId);
    // Exactly one identity is visible, and §6.3 names it: the recipient.
    expect(blob).toContain(pair.b.personaId);
  });

  it('the ciphertext really is the message — the recipient key opens it', async () => {
    // Positive control. Without this, "the hub sees no plaintext" would also be satisfied by a
    // transport that sent nothing at all.
    const envelope = hub.visibleState()[0]!.envelope;
    // The AAD is part of the envelope's contract, not the client's internals: `recipient` and
    // `sent_at` are readable by the hub and bound by the tag, so anything opening the blob has to
    // reproduce them. A reader that skipped them would be accepting fields a courier could edit.
    const opened = JSON.parse(
      Buffer.from(
        openSealed(persona(1).dhPrivateKey, pair.b.personaId, envelope.sealed, hubEnvelopeAad(envelope)),
      ).toString('utf8'),
    );
    expect(opened.type).toBe('propose');
    expect(opened.payload.edge.edge_id).toBe(edgeId);
    // …and even opened, it carries hashes, not the commitment text (M-7 proper).
    expect(JSON.stringify(opened)).not.toContain(INTENT);
    expect(opened.payload.edge.commitment_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('§6.3: a courier may READ the outer fields and MUST NOT be able to change them', () => {
    // `recipient` and `sent_at` are outside the ciphertext because a hub needs them — to route,
    // and to expire a queue entry. Outside used to mean unauthenticated: a hostile courier could
    // rewrite `sent_at` on anything it held and the recipient would open the message and believe
    // it. Binding them as associated data keeps them readable and makes them immutable.
    const envelope = hub.visibleState()[0]!.envelope;
    const rewritten = { ...envelope, sent_at: '2020-01-01T00:00:00Z' };

    expect(() =>
      openSealed(persona(1).dhPrivateKey, pair.b.personaId, rewritten.sealed, hubEnvelopeAad(rewritten)),
    ).toThrow();
    // The control: with the fields as sent, the very same blob opens.
    expect(() =>
      openSealed(persona(1).dhPrivateKey, pair.b.personaId, envelope.sealed, hubEnvelopeAad(envelope)),
    ).not.toThrow();
  });

  it('a hub MUST NOT accept an envelope carrying anything else (a leak the sender offers)', () => {
    const good = hub.visibleState()[0]!.envelope;
    expect(() => hub.deliver({ ...good, sender: pair.a.personaId })).toThrowError(/§6\.3/);
    expect(() => hub.deliver({ ...good, edge_id: edgeId })).toThrowError(/§6\.3/);
    expect(() => hub.deliver({ ...good, sealed: { ...good.sealed, intent: INTENT } })).toThrowError(/§6\.3/);
  });

  it('§6.6: a recovery response carries edges and chains, and no commitment intent', async () => {
    await pair.b.fed.pull();
    expect(pair.b.node.confirm({ id: edgeId, decision: 'confirm' })).toEqual({ state: 'confirmed' });

    const responder = new RecoveryResponder({ vault: pair.b.vault, persona: pair.b.personaId });
    const challenge = responder.issueChallenge();
    const { verdict, response } = responder.answer({
      persona: pair.a.personaId,
      proof: signChallenge(challenge, pair.a.privateKey),
    });

    expect(verdict.verified).toBe(true);
    expect(response.edges.map((e) => e.edge.edge_id)).toEqual([edgeId]);
    expect(response.edges[0]!.assertions.length).toBe(2);

    const blob = JSON.stringify(response);
    expect(blob).not.toContain(INTENT);
    expect(blob).not.toContain('reconciliation');
    // Every field that could have carried content is a hash or a state.
    expect(response.edges[0]!.edge.commitment_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const a of response.edges[0]!.assertions) {
      expect(a.evidence_hash === null || /^[0-9a-f]{64}$/.test(a.evidence_hash)).toBe(true);
    }
    expect(Object.keys(response)).toEqual(['edges']);
    expect(Object.keys(response.edges[0]!).sort()).toEqual(['assertions', 'edge']);
  });

  it('§6.6: an unverified requester gets an empty response, not a redacted one', () => {
    const responder = new RecoveryResponder({ vault: pair.b.vault, persona: pair.b.personaId });
    const { verdict, response } = responder.answer({
      persona: pair.a.personaId,
      // A challenge this responder never issued: possession at an unknown time proves nothing.
      proof: signChallenge('a challenge I made up', pair.a.privateKey),
    });
    expect(verdict.verified).toBe(false);
    expect(response.edges).toEqual([]);
  });
});
