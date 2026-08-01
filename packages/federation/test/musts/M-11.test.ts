import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HUB_VISIBLE_FIELDS, MemoryHub } from '../../src/hub.js';
import { HubClient, hubFetch } from '../../src/hub-transport.js';
import type { DerivedPersona } from '@servanda/crypto';
import { signMessage } from '../../src/messages.js';
import { answerReconRequest } from '../../src/recon.js';
import { dhDirectory, makeSolo, persona, type Solo } from '../support/fixture.js';

/**
 * M-11 — "No network-level reputation: nodes and hubs MUST NOT compute, store, or serve
 * cross-party fulfillment statistics; clients MAY display only local pairwise history."
 *
 * §8 makes a hub its own conformance level, and this is half of what it means. The rule is
 * enforced structurally rather than by a policy check: a hub that never learns who sent an
 * envelope cannot pair two parties, and therefore cannot compute a cross-party statistic even
 * if a later version of it wanted to. Absence is the mechanism, so the test asserts the absence.
 */

const A = persona(0);
const B = persona(1);
const C = persona(2);

const hub = new MemoryHub({ now: () => new Date('2026-07-25T09:00:00.000Z') });

const directory = dhDirectory([A, B, C]);

function clientFor(p: DerivedPersona): HubClient {
  return new HubClient({
    baseUrl: 'https://hub.example',
    persona: p.personaId,
    privateKey: p.privateKey,
    dhPrivateKey: p.dhPrivateKey,
    fetch: hubFetch(hub),
    resolveDhKey: directory,
    now: () => new Date('2026-07-25T09:00:00.000Z'),
  });
}

let solo: Solo;

beforeAll(async () => {
  solo = makeSolo(1);
  // Two different senders, one recipient — the exact shape a fulfillment statistic would need.
  for (const sender of [A, C]) {
    const message = signMessage(
      'recon_request',
      { edges: [] },
      sender.personaId,
      B.personaId,
      '2026-07-25T09:00:00.000Z',
      sender.privateKey,
    );
    await clientFor(sender).send(B.personaId, message);
  }
});
afterAll(() => solo.cleanup());

describe('M-11: a hub MUST NOT compute or serve cross-party fulfillment statistics', () => {
  it('the hub never learns a sender, so no (sender, recipient) pair exists to count', () => {
    const state = hub.visibleState();
    expect(state).toHaveLength(2);
    const blob = JSON.stringify(state);
    expect(blob).not.toContain(A.personaId);
    expect(blob).not.toContain(C.personaId);
    for (const stored of state) {
      expect(Object.keys(stored.envelope).sort()).toEqual([...HUB_VISIBLE_FIELDS].sort());
      expect(stored.envelope.recipient).toBe(B.personaId);
    }
    // Both envelopes are indistinguishable except by ciphertext: nothing groups them by sender.
    expect(new Set(state.map((s) => s.envelope.recipient)).size).toBe(1);
  });

  it('the hub exposes no method that counts, aggregates, or ranks anything', () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(hub))
      .filter((n) => n !== 'constructor' && typeof (hub as unknown as Record<string, unknown>)[n] === 'function')
      .sort();
    // A statistics endpoint added later would fail here rather than pass silently. `expire` is
    // TTL housekeeping (§6.7); `visibleState` is the test's window onto the hub's whole state.
    expect(methods).toEqual(['challenge', 'deliver', 'expire', 'inbox', 'visibleState']);
  });

  it('an authenticated inbox read returns envelopes and no derived numbers', async () => {
    const delivered = await clientFor(B).receive(B.personaId);
    expect(delivered).toHaveLength(2);
    for (const message of delivered) {
      // `recipient` is inside the signed message (§6.2). It widens nothing a hub sees — the
      // whole message is sealed, and the hub already routes by a recipient on the outer envelope.
      expect(Object.keys(message).sort()).toEqual(
        ['payload', 'recipient', 'sender', 'sent_at', 'sig', 'type', 'v'],
      );
    }
    // The recipient learns the senders — that is local pairwise knowledge, which M-11 permits.
    // The hub, which relayed the same two messages, did not.
    expect(new Set(delivered.map((m) => m.sender))).toEqual(new Set([A.personaId, C.personaId]));
  });

  it('a §6.4 recon response carries edges and chains — never counts, rates, or scores', () => {
    const response = answerReconRequest(solo.vault, solo.personaId, A.personaId, {
      edges: [{ edge_id: 'a'.repeat(64), latest_assertion_hash: '0'.repeat(64) }],
    });
    expect(Object.keys(response)).toEqual(['edges']);
    for (const entry of response.edges) {
      expect(Object.keys(entry).sort()).toEqual(['assertions', 'edge_id']);
    }
  });

  it('federation never accumulates a third party’s edge, so no node can compute across parties', () => {
    // §7's `localPairwiseHistory` refuses to run over an edge the persona is not a party to.
    // The wire is the only way such an edge could ever enter a vault; it does not.
    const foreign = {
      v: 'servanda/0.2' as const,
      type: 'edge' as const,
      edge_id: 'b'.repeat(64),
      commitment_hash: 'c'.repeat(64),
      owner: A.personaId,
      owed_to: C.personaId,
      proposed_at: '2026-07-25T09:00:00Z',
      due: null,
      closure_policy: 'on-acceptance' as const,
      acceptance_window: 'P5D',
      blocked_by: [],
      supersedes: null,
    };
    const result = solo.inbox.ingest([
      signMessage(
        'recon_response',
        { edges: [{ edge_id: foreign.edge_id, assertions: [] }] },
        A.personaId,
        solo.personaId,
        '2026-07-25T09:00:00Z',
        A.privateKey,
      ),
    ]);
    expect(result.recon.ignored).toEqual([foreign.edge_id]);
    expect(solo.vault.listEdgeIds(solo.personaId)).toEqual([]);
  });
});
