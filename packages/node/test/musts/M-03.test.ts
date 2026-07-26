import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { Assertion, Edge, PROTOCOL_VERSION } from '@servanda/types';
import { verifyAssertionChain } from '../../src/transitions.js';
import { makeFixture, persona, syncEdge, type Fixture } from '../support/fixture.js';
import { invalidVector } from '../support/vectors.js';

/**
 * M-3 — Edges are strictly two-party. Multiplicity only via fan-out (shared commitment_hash)
 * and collective (group owner + decomposition).
 *
 * Owned by this layer (transition table + node).
 */

let fx: Fixture;
let edgeId: string;

beforeAll(() => {
  fx = makeFixture();
  edgeId = fx.node.commit({
    intent: 'review the spec',
    owed_to: fx.personas[1]!,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  syncEdge(fx, 0, 1, edgeId);
});
afterAll(() => fx.cleanup());

describe('M-3: edges are strictly two-party', () => {
  it('an edge names exactly two parties', () => {
    const edge = fx.vault.getEdge(fx.personas[0]!, edgeId)!;
    expect(Object.keys(edge).filter((k) => k === 'owner' || k === 'owed_to')).toHaveLength(2);
    expect(edge.owner).not.toBe(edge.owed_to);
  });

  it('discards a validly-signed assertion from a third key', () => {
    const outsider = persona(2);
    const edge = fx.vault.getEdge(fx.personas[0]!, edgeId)!;
    const forged = withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'assertion' as const,
        edge_id: edgeId,
        state: 'confirmed' as const,
        asserted_at: '2026-07-25T12:00:00Z',
        by: outsider.personaId,
        evidence_hash: null,
      },
      outsider.privateKey,
    ) as Assertion;

    const chain = [...fx.vault.getAssertions(fx.personas[0]!, edgeId), forged];
    const result = verifyAssertionChain(edge, chain);
    // The signature is perfectly valid. Being a party is a separate, and stricter, question.
    expect(result.outcomes.at(-1)).toEqual({
      index: chain.length - 1,
      accepted: false,
      rejection_reason: 'signer-not-a-party',
    });
    expect(result.final_state).toBe('proposed');
  });

  it('refuses to record a confirmation from a persona that is not a party', () => {
    // persona 2 is not in the fixture vault, so the closest reachable case is the owner acting
    // where only owed_to may: the node must refuse rather than write an invalid chain.
    expect(() => fx.node.confirm({ id: edgeId, decision: 'confirm' })).toThrow(/M-2|M-3/);
  });

  it('rejects the third-party vectors (confirmed-by-third-party, superseded-by-third-party)', () => {
    for (const name of ['confirmed-by-third-party', 'superseded-by-third-party']) {
      const c = invalidVector(name);
      const result = verifyAssertionChain(
        Edge.parse(c.edge),
        c.assertions.map((a) => Assertion.parse(a)),
      );
      expect(result.outcomes.at(-1)?.rejection_reason).toBe('signer-not-a-party');
    }
  });

  it('fan-out is the sanctioned multiplicity: N edges, one commitment_hash', () => {
    // §4.6: edges sharing a commitment_hash are independent and mutually invisible.
    const edge = fx.vault.getEdge(fx.personas[0]!, edgeId)!;
    const sibling = { ...edge, edge_id: 'f'.repeat(64), owed_to: persona(2).personaId };
    expect(sibling.commitment_hash).toBe(edge.commitment_hash);
    expect(sibling.edge_id).not.toBe(edge.edge_id);
  });
});
