import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Assertion, Edge } from '@servanda/types';
import { verifyAssertionChain } from '../../src/transitions.js';
import { callTool } from '../../src/tools.js';
import { makeFixture, type Fixture } from '../support/fixture.js';
import { invalidVector } from '../support/vectors.js';

/**
 * M-1 — A promise is owned by its giver: no wire object may create a commitment whose owner is
 * not the signing persona (or its group). "They said they would" is an expectation, never a
 * proposal on their behalf.
 *
 * Owned by this layer (node + transition table).
 */

let fx: Fixture;
beforeAll(() => {
  fx = makeFixture();
});
afterAll(() => fx.cleanup());

describe('M-1: a promise is owned by its giver', () => {
  it('rejects `commit` carrying an owner other than the calling persona', () => {
    expect(() =>
      callTool(fx.node, 'commit', {
        intent: 'they will send the contract',
        owed_to: null,
        due: null,
        owner: fx.personas[1],
      }),
    ).toThrow(/M-1/);
  });

  it('records the calling persona as owner, never the counterparty', () => {
    const out = callTool(fx.node, 'commit', {
      intent: 'send the contract',
      owed_to: fx.personas[1],
      due: null,
    }) as { commitment_hash: string };
    const stored = fx.vault.getCommitment(fx.personas[0]!, out.commitment_hash);
    expect(stored?.owner).toBe(fx.personas[0]);
  });

  it('offers `expect` as the object for what someone else said they would do', () => {
    const { expectation_id } = callTool(fx.node, 'expect', {
      expect: 'they will send the contract',
      from: fx.personas[1]!,
    }) as { expectation_id: string };

    const expectation = fx.vault.getExpectation(fx.personas[0]!, expectation_id);
    expect(expectation?.type).toBe('expectation');
    // ADR-0013: an expectation MUST NOT appear in any wire message. Recording one queues nothing.
    expect(fx.vault.listOutbox(fx.personas[0]!).map((o) => o.message['type'])).not.toContain(
      'expectation',
    );
  });

  it('rejects a `proposed` assertion signed by anyone but the owner (vector: proposed-by-owed-to)', () => {
    const c = invalidVector('proposed-by-owed-to');
    const result = verifyAssertionChain(
      Edge.parse(c.edge),
      c.assertions.map((a) => Assertion.parse(a)),
    );
    expect(result.outcomes[0]).toEqual({
      index: 0,
      accepted: false,
      rejection_reason: 'wrong-signer-for-transition',
    });
    expect(result.final_state).toBe('none');
  });
});
