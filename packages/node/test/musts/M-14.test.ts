import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { Assertion, Edge, PROTOCOL_VERSION, RejectionReason } from '@servanda/types';
import { verifyAssertionChain } from '../../src/transitions.js';
import { makeFixture, persona, syncEdge, type Fixture } from '../support/fixture.js';

/**
 * M-14 — Assertions violating the transition table are invalid and MUST be discarded.
 *
 * Owned by this layer. The exhaustive proof is `transitions-vectors.test.ts` (all 26 cases,
 * exact reason strings). This file asserts the properties the vectors imply: every negative
 * vector is rejected, a rejected assertion never advances the state, and the node refuses to
 * write an invalid assertion into its own chain.
 */

const VECTORS = process.env['SERVANDA_VECTORS'] ?? join(process.cwd(), 'vendor/vectors');

interface VectorCase {
  name: string;
  edge: unknown;
  assertions: unknown[];
  expected_outcomes: { index: number; accepted: boolean; rejection_reason: string | null }[];
  expected_final_state: string;
}

const invalidCases: VectorCase[] = (
  JSON.parse(readFileSync(join(VECTORS, 'transitions/invalid.json'), 'utf8')) as {
    cases: VectorCase[];
  }
).cases;

let fx: Fixture;
let edgeId: string;

beforeAll(() => {
  fx = makeFixture();
  edgeId = fx.node.commit({
    intent: 'the promise',
    owed_to: fx.personas[1]!,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  syncEdge(fx, 0, 1, edgeId);
});
afterAll(() => fx.cleanup());

describe('M-14: assertions violating the transition table are discarded', () => {
  it('all 19 negative vectors are rejected with the reason the suite states', () => {
    expect(invalidCases).toHaveLength(19);
    for (const c of invalidCases) {
      const result = verifyAssertionChain(
        Edge.parse(c.edge),
        c.assertions.map((a) => Assertion.parse(a)),
      );
      expect(
        result.outcomes.map((o) => ({
          index: o.index,
          accepted: o.accepted,
          rejection_reason: o.rejection_reason ?? null,
        })),
        c.name,
      ).toEqual(c.expected_outcomes);
      expect(result.final_state, c.name).toBe(c.expected_final_state);
    }
  });

  it('every rejection reason is drawn from the §4.3 vocabulary, never free text', () => {
    for (const c of invalidCases) {
      for (const o of verifyAssertionChain(
        Edge.parse(c.edge),
        c.assertions.map((a) => Assertion.parse(a)),
      ).outcomes) {
        if (o.rejection_reason) {
          expect(() => RejectionReason.parse(o.rejection_reason)).not.toThrow();
        }
      }
    }
  });

  it('a discarded assertion never advances the state', () => {
    const edge = fx.vault.getEdge(fx.personas[0]!, edgeId)!;
    const before = verifyAssertionChain(edge, fx.vault.getAssertions(fx.personas[0]!, edgeId));

    const outsider = persona(2);
    const invalid = withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'assertion' as const,
        edge_id: edgeId,
        state: 'confirmed' as const,
        asserted_at: '2026-07-26T00:00:00Z',
        by: outsider.personaId,
        evidence_hash: null,
      },
      outsider.privateKey,
    ) as Assertion;

    const after = verifyAssertionChain(edge, [
      ...fx.vault.getAssertions(fx.personas[0]!, edgeId),
      invalid,
    ]);
    expect(after.final_state).toBe(before.final_state);
    expect(after.outcomes.at(-1)?.accepted).toBe(false);
  });

  it('the node refuses to write an invalid assertion into its own chain', () => {
    // The owner attempting to confirm their own proposal: the node validates its own output
    // against the table before appending, so an invalid chain cannot originate here.
    const chainBefore = fx.vault.getAssertions(fx.personas[0]!, edgeId).length;
    expect(() => fx.node.confirm({ id: edgeId, decision: 'confirm' })).toThrow();
    expect(fx.vault.getAssertions(fx.personas[0]!, edgeId)).toHaveLength(chainBefore);
  });

  it('the chain is retained in full, including around discarded assertions (§4.2)', () => {
    // Append-only: the store offers no way to remove or rewrite an assertion.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(fx.vault))).not.toContain(
      'deleteAssertion',
    );
    expect(fx.vault.getAssertions(fx.personas[0]!, edgeId).map((a) => a.state)).toEqual([
      'proposed',
    ]);
  });
});
