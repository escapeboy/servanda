import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Assertion, Edge } from '@servanda/types';
import { verifyAssertionChain } from '../../src/transitions.js';
import { makeFixture, nodeAs, syncEdge, type Fixture } from '../support/fixture.js';
import { invalidVector } from '../support/vectors.js';

/**
 * M-2 — Cross-person edges require the owner's `proposed` signature and the counterparty's
 * `confirmed` signature; unconfirmed proposals MUST NOT be treated as existing promises.
 *
 * Owned by this layer (node + transition table).
 */

let fx: Fixture;
let edgeId: string;

beforeAll(() => {
  fx = makeFixture();
  const out = fx.node.commit({
    intent: 'ship the reference implementation',
    owed_to: fx.personas[1]!,
    due: '2026-08-01T00:00:00Z',
    persona: null,
    propose: true,
  });
  edgeId = out.edge_id!;
});
afterAll(() => fx.cleanup());

describe('M-2: an unconfirmed proposal is not a promise', () => {
  it('a fresh proposal is `proposed`, not `open`', () => {
    expect(fx.node.edgeState(fx.personas[0]!, edgeId).final_state).toBe('proposed');
  });

  it('the owner cannot supply the counterparty’s confirmation', () => {
    expect(() => fx.node.confirm({ id: edgeId, decision: 'confirm' })).toThrow(/M-2/);
    expect(fx.node.edgeState(fx.personas[0]!, edgeId).final_state).toBe('proposed');
  });

  it('the counterparty’s signature is what makes the edge exist', () => {
    syncEdge(fx, 0, 1, edgeId);
    const them = nodeAs(fx, 1);
    expect(them.confirm({ id: edgeId, decision: 'confirm' })).toEqual({ state: 'confirmed' });
    // §4.3 interpretation #3: confirmed ≡ open.
    expect(them.edgeState(fx.personas[1]!, edgeId).final_state).toBe('open');
  });

  it('both signatures are present across the chain once confirmed', () => {
    const chain = fx.vault.getAssertions(fx.personas[1]!, edgeId);
    expect(chain.map((a) => a.state)).toEqual(['proposed', 'confirmed']);
    expect(new Set(chain.map((a) => a.by))).toEqual(
      new Set([fx.personas[0]!, fx.personas[1]!]),
    );
  });

  it('rejects an owner self-confirmation on the wire (vector: owner-self-confirms)', () => {
    const c = invalidVector('owner-self-confirms');
    const result = verifyAssertionChain(
      Edge.parse(c.edge),
      c.assertions.map((a) => Assertion.parse(a)),
    );
    expect(result.outcomes[1]?.rejection_reason).toBe('wrong-signer-for-transition');
    expect(result.final_state).toBe('proposed');
  });

  it('an unconfirmed proposal cannot be closed (vector: closed-without-confirmation)', () => {
    const c = invalidVector('closed-without-confirmation');
    const result = verifyAssertionChain(
      Edge.parse(c.edge),
      c.assertions.map((a) => Assertion.parse(a)),
    );
    expect(result.outcomes[1]?.rejection_reason).toBe('illegal-source-state');
    expect(result.final_state).toBe('proposed');
  });
});
