import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectiveState } from '@servanda/node';
import { EMPTY_CHAIN_HASH, applyReconResponse, answerReconRequest, buildReconRequest, latestAssertionHash } from '../src/recon.js';
import { makePair, type Pair } from './support/fixture.js';

/**
 * §6.4 reconciliation.
 *
 * The scenario is the one §6.7 says is normal rather than exceptional: a delivery is lost, the
 * two nodes diverge, and the next recon exchange heals it. "Loss of any queued message is
 * healed by the next §6.4 recon exchange between the parties."
 */

let pair: Pair;
let edgeId: string;

beforeAll(async () => {
  pair = makePair();
  edgeId = pair.a.node.commit({
    intent: 'reconcile after a dropped delivery',
    owed_to: pair.b.personaId,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  await pair.a.fed.push();
  await pair.b.fed.pull();
});
afterAll(() => pair.cleanup());

const stateFor = (peer: Pair['a']) =>
  effectiveState(peer.vault.getEdge(peer.personaId, edgeId)!, peer.vault.getAssertions(peer.personaId, edgeId));

describe('§6.4 reconciliation', () => {
  it('the request names every shared open edge with the hash of its latest assertion', () => {
    const request = buildReconRequest(pair.b.vault, pair.b.personaId, pair.a.personaId);
    expect(request.edges).toHaveLength(1);
    expect(request.edges[0]!.edge_id).toBe(edgeId);
    expect(request.edges[0]!.latest_assertion_hash).toBe(
      latestAssertionHash(pair.b.vault.getAssertions(pair.b.personaId, edgeId)),
    );
    expect(request.edges[0]!.latest_assertion_hash).not.toBe(EMPTY_CHAIN_HASH);
  });

  it('divergence caused by a lost delivery is healed by one exchange', () => {
    // B confirms. The `assert` message is never pushed — the transport lost it.
    pair.b.node.confirm({ id: edgeId, decision: 'confirm' });
    expect(stateFor(pair.b)).toBe('open');
    expect(stateFor(pair.a)).toBe('proposed');

    const request = buildReconRequest(pair.a.vault, pair.a.personaId, pair.b.personaId);
    const response = answerReconRequest(pair.b.vault, pair.b.personaId, pair.a.personaId, request);
    const applied = applyReconResponse(pair.a.vault, pair.a.personaId, response);

    expect(applied.accepted).toHaveLength(1);
    expect(applied.discarded).toEqual([]);
    expect(stateFor(pair.a)).toBe('open');
  });

  it('both sides now see the same chain, and a second round moves nothing', () => {
    const chain = (peer: Pair['a']) => peer.vault.getAssertions(peer.personaId, edgeId).map((a) => a.sig);
    expect(chain(pair.a)).toEqual(chain(pair.b));

    const request = buildReconRequest(pair.a.vault, pair.a.personaId, pair.b.personaId);
    expect(answerReconRequest(pair.b.vault, pair.b.personaId, pair.a.personaId, request).edges).toEqual([]);
  });

  it('re-applying a response is idempotent — a transport may replay anything', () => {
    const response = {
      edges: [{ edge_id: edgeId, assertions: pair.b.vault.getAssertions(pair.b.personaId, edgeId) }],
    };
    const applied = applyReconResponse(pair.a.vault, pair.a.personaId, response);
    expect(applied.accepted).toEqual([]);
    expect(applied.discarded).toEqual([]);
  });

  it('reconciliation never escalates — it only makes both sides see the same chain', () => {
    // §6.4: "Escalation on drift is a local decision of the owner's node." Nothing in the
    // exchange above produced an outbox item, a notification, or a state change beyond the
    // chain itself.
    const before = pair.a.vault.listOutbox(pair.a.personaId).length;
    const request = buildReconRequest(pair.a.vault, pair.a.personaId, pair.b.personaId);
    applyReconResponse(
      pair.a.vault,
      pair.a.personaId,
      answerReconRequest(pair.b.vault, pair.b.personaId, pair.a.personaId, request),
    );
    expect(pair.a.vault.listOutbox(pair.a.personaId).length).toBe(before);
  });

  it('a node with an empty chain announces EMPTY_CHAIN_HASH and receives everything', () => {
    const request = { edges: [{ edge_id: edgeId, latest_assertion_hash: EMPTY_CHAIN_HASH }] };
    const response = answerReconRequest(pair.b.vault, pair.b.personaId, pair.a.personaId, request);
    expect(response.edges[0]!.assertions).toHaveLength(2);
  });
});
