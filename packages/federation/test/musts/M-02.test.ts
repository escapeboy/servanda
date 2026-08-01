import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { effectiveState, verifyAssertionChain } from '@servanda/node';
import { signMessage } from '../../src/messages.js';
import { makePair, type Pair } from '../support/fixture.js';

/**
 * M-2 — "Cross-person edges require the owner's `proposed` signature and the counterparty's
 * `confirmed` signature; unconfirmed proposals MUST NOT be treated as existing promises."
 *
 * L1 proves this inside one vault. This file proves it BETWEEN TWO NODES: two vaults, two
 * working clones, one local bare repository, no network. That is the property §6 exists for —
 * the same guarantee has to survive the wire, where the only thing binding the counterparty is
 * their own signature arriving back.
 */

let pair: Pair;
let edgeId: string;

beforeAll(() => {
  pair = makePair();
});
afterAll(() => pair.cleanup());

const chainOf = (peer: Pair['a']) =>
  peer.vault.getAssertions(peer.personaId, edgeId).map((a) => `${a.state}:${a.by.slice(0, 8)}:${a.sig.slice(0, 16)}`);

describe('M-2: a proposal is not a promise until the counterparty signs — across two nodes', () => {
  it('A proposes; the propose message reaches B over the transport', async () => {
    const out = pair.a.node.commit({
      intent: 'send the quarterly numbers',
      owed_to: pair.b.personaId,
      due: null,
      persona: null,
      propose: true,
    });
    edgeId = out.edge_id!;
    expect(out.state).toBe('proposed');

    expect(await pair.a.fed.push()).toBeGreaterThan(0);
    const result = await pair.b.fed.pull();
    expect(result.accepted.map((a) => a.type)).toContain('propose');
    expect(result.discarded).toEqual([]);
    expect(pair.b.vault.getEdge(pair.b.personaId, edgeId)).not.toBeNull();
  });

  it('both nodes see `proposed` — B holding it is not B having promised anything', () => {
    const a = pair.a.vault;
    const b = pair.b.vault;
    expect(effectiveState(a.getEdge(pair.a.personaId, edgeId)!, a.getAssertions(pair.a.personaId, edgeId))).toBe(
      'proposed',
    );
    expect(effectiveState(b.getEdge(pair.b.personaId, edgeId)!, b.getAssertions(pair.b.personaId, edgeId))).toBe(
      'proposed',
    );
  });

  it('the owner cannot manufacture the counterparty’s confirmation on the wire', async () => {
    // A signs `confirmed` itself and pushes it as a wire `assert`. B must discard it: §4.3 says
    // only `owed_to` may confirm, and the wire is not a lenient variant of the table (M-14).
    expect(pair.a.vault.getAssertions(pair.a.personaId, edgeId)).toHaveLength(1);

    const assertion = withSignature(
      {
        v: 'servanda/0.2' as const,
        type: 'assertion' as const,
        edge_id: edgeId,
        state: 'confirmed' as const,
        asserted_at: '2026-07-25T10:00:00.000Z',
        by: pair.a.personaId,
        evidence_hash: null,
      },
      pair.a.privateKey,
    );
    const message = signMessage(
      'assert',
      { assertion },
      pair.a.personaId,
      pair.b.personaId,
      '2026-07-25T10:00:00.000Z',
      pair.a.privateKey,
    );
    await pair.a.transport.send(pair.b.personaId, message);
    await pair.a.transport.sync();

    const result = await pair.b.fed.pull();
    expect(result.discarded).toEqual([
      { type: 'assert', edge_id: edgeId, reason: 'transition-table:wrong-signer-for-transition' },
    ]);
    expect(pair.b.vault.getAssertions(pair.b.personaId, edgeId)).toHaveLength(1);
  });

  it('B confirms; the confirmation travels back and both nodes converge on `open`', async () => {
    expect(pair.b.node.confirm({ id: edgeId, decision: 'confirm' })).toEqual({ state: 'confirmed' });
    await pair.b.fed.push();
    const result = await pair.a.fed.pull();
    expect(result.accepted.map((a) => a.type)).toContain('assert');

    for (const peer of [pair.a, pair.b]) {
      const edge = peer.vault.getEdge(peer.personaId, edgeId)!;
      const chain = peer.vault.getAssertions(peer.personaId, edgeId);
      const verification = verifyAssertionChain(edge, chain);
      expect(verification.outcomes.every((o) => o.accepted)).toBe(true);
      expect(verification.final_state).toBe('open');
    }
  });

  it('the two nodes hold the same chain, assertion for assertion', () => {
    expect(chainOf(pair.a)).toEqual(chainOf(pair.b));
    expect(chainOf(pair.a)).toHaveLength(2);
    // Same edge object too — the edge_id is a hash of its own fields (§4.1), so agreement on
    // the id is agreement on the content.
    expect(pair.a.vault.getEdge(pair.a.personaId, edgeId)).toEqual(
      pair.b.vault.getEdge(pair.b.personaId, edgeId),
    );
  });

  it('the counterparty never received the commitment plaintext (M-7 at the edge of M-2)', () => {
    const edge = pair.b.vault.getEdge(pair.b.personaId, edgeId)!;
    expect(pair.b.vault.getCommitment(pair.b.personaId, edge.commitment_hash)).toBeNull();
    expect(JSON.stringify(edge)).not.toContain('quarterly');
  });
});
