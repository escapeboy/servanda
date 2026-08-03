import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAssertionChain } from '@servanda/node';
import { makePair, settle, type Pair } from '../support/fixture.js';

/**
 * §6.4: *"reconciliation only guarantees both sides see the same chain"* — the promise the whole
 * of §6 rests on, and the one federation exists to keep.
 *
 * **It did not hold, and no hostility was involved.** §4.3 gives `open` three exits a single party
 * may take alone, and they are mutually exclusive. Partition two HONEST nodes, let the owner close
 * with evidence while the counterparty releases, and each accepted its own act and refused the
 * other's — forever. `latestAssertionHash` disagreed permanently, so reconciliation never reached
 * "nothing to send": A kept listing the edge, B kept answering with a chain A discarded, every
 * round, for the life of the vault.
 *
 * §6.4's resolution rule — *"assertions invalid per §4.3 are discarded; the valid chain wins"* —
 * assumes ONE valid chain exists. Here both were valid and there was no tie-break, because a
 * tie-break would have silently thrown away a signed act.
 *
 * `contested-closure` is the resolution: both nodes compute it from the same chain, so they
 * converge, and both assertions stand. This file is the regression, and the property it pins is
 * **convergence**, not the name of the state.
 */

let pair: Pair;
let edge_id: string;
afterAll(() => pair?.cleanup());

/**
 * The story runs in the hook, and that is not tidying.
 *
 * It used to run inside the first `it`, where the 30 s `testTimeout` applies — and it is eight
 * settle rounds of git fetch/commit/push across two vaults, ~17 s on a quiet machine and past 30
 * on a loaded one. So a MUST test failed by TIMEOUT, never by assertion, on a run where nothing
 * was wrong; both an adversarial pass and an independent one hit it on the same afternoon.
 *
 * `vitest.config.ts` already draws the line this belongs on: `hookTimeout` is 180 s and
 * `testTimeout` is 30 s because *"a slow setup is expected, a slow assertion still means
 * something is wrong."* Expensive I/O was on the wrong side of it. Nothing here is faster; the
 * three assertions below are now the only thing being timed, which is what the numbers meant.
 *
 * It also removes a hidden ordering dependency: the second and third cases already read state the
 * first one produced.
 */
beforeAll(async () => {
  pair = makePair();
  const { a, b } = pair;

  edge_id = a.node.commit({
    intent: 'ship the migration',
    owed_to: b.personaId,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  await settle(pair);
  b.node.confirm({ id: edge_id, decision: 'confirm' });
  await settle(pair);

  // The partition. Neither has seen the other's act when it signs its own, and both are legal:
  // §4.3 `open → closed` is the owner's with evidence, `open → released` is the creditor's.
  a.node.act({ id: edge_id, act: 'done', evidence_hash: 'e'.repeat(64) });
  b.node.act({ id: edge_id, act: 'release', evidence_hash: null });

  // Heal, and keep exchanging. Before the fix this ran forever without converging.
  await settle(pair, 3);
});

describe('§6.4: two honest nodes converge even when they exit `open` concurrently', () => {
  it('owner closes and creditor releases in the same window', () => {
    const { a, b } = pair;
    const stateOf = (peer: typeof a) => {
      const edge = peer.vault.getEdge(peer.personaId, edge_id)!;
      return verifyAssertionChain(edge, peer.vault.getAssertions(peer.personaId, edge_id)).final_state;
    };

    expect(stateOf(a)).toBe(stateOf(b));
    expect(stateOf(a)).toBe('contested-closure');
  });

  it('and both signed acts survive on both sides', async () => {
    // The property a tie-break would have destroyed. Each node holds both assertions, and neither
    // party's act was discarded to make the other's fit.
    const { a, b } = pair;
    const edgeId = a.vault.listEdgeIds(a.personaId)[0]!;

    for (const peer of [a, b]) {
      const states = peer.vault
        .getAssertions(peer.personaId, edgeId)
        .map((x) => x.state)
        .sort();
      expect(states, peer.personaId.slice(0, 8)).toEqual(['closed', 'confirmed', 'proposed', 'released']);
    }
  });

  it('reconciliation reaches "nothing to send" — the thing that never happened before', async () => {
    // Convergence is not "the states match once". It is that the exchange TERMINATES: while the
    // two chains hashed differently, every round re-offered a chain the other end re-discarded.
    const { a, b } = pair;
    const edgeId = a.vault.listEdgeIds(a.personaId)[0]!;
    const { latestAssertionHash } = await import('../../src/recon.js');

    expect(latestAssertionHash(a.vault.getAssertions(a.personaId, edgeId))).toBe(
      latestAssertionHash(b.vault.getAssertions(b.personaId, edgeId)),
    );
  });
});
