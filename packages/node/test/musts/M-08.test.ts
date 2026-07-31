import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { type Assertion, Edge, PROTOCOL_VERSION } from '@servanda/types';
import { mayAutoEscalate } from '../../src/escalation.js';
import { verifyAssertionChain } from '../../src/transitions.js';
import { makeFixture, nodeAs, persona, syncEdge, type Fixture } from '../support/fixture.js';

/**
 * M-8 — Unverifiable edges (no adapter, or invalid collective) MUST NOT auto-escalate.
 * §4.3 adds the other bar: expiry "only if `due` non-null", and §3.1 "undated commitments MUST
 * NOT time-escalate".
 *
 * Owned by this layer.
 */

let fx: Fixture;
let datedEdge: string;
let undatedEdge: string;

beforeAll(() => {
  fx = makeFixture();
  datedEdge = fx.node.commit({
    intent: 'dated promise',
    owed_to: fx.personas[1]!,
    due: '2026-08-01T00:00:00Z',
    persona: null,
    propose: true,
  }).edge_id!;
  undatedEdge = fx.node.commit({
    intent: 'undated promise',
    owed_to: fx.personas[1]!,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  for (const id of [datedEdge, undatedEdge]) {
    syncEdge(fx, 0, 1, id);
    nodeAs(fx, 1).confirm({ id, decision: 'confirm' });
    syncEdge(fx, 1, 0, id);
  }
  fx.setNow(new Date('2026-09-01T00:00:00.000Z')); // a month past the dated edge's due
});
afterAll(() => fx.cleanup());

function collective(coordinator: string | null, children: string[]): Edge {
  return Edge.parse({
    v: PROTOCOL_VERSION,
    type: 'edge',
    edge_id: 'a'.repeat(64),
    commitment_hash: 'b'.repeat(64),
    owner: persona(2).personaId,
    owed_to: persona(7).personaId,
    proposed_at: '2026-07-01T00:00:00Z',
    due: '2026-07-10T00:00:00Z',
    closure_policy: 'on-acceptance',
    acceptance_window: 'P5D',
    blocked_by: [],
    fulfillment: {
      policy: 'all',
      children,
      ...(coordinator ? { coordinator } : {}),
    },
    supersedes: null,
  });
}

describe('M-8: unverifiable edges MUST NOT auto-escalate', () => {
  it('escalates an overdue, verifiable, open edge', () => {
    expect(fx.node.escalatable(fx.personas[0]!)).toContain(datedEdge);
  });

  it('never escalates an undated edge, however old (§3.1)', () => {
    expect(fx.node.escalatable(fx.personas[0]!)).not.toContain(undatedEdge);
    fx.setNow(new Date('2126-09-01T00:00:00.000Z')); // a century later
    expect(fx.node.escalatable(fx.personas[0]!)).not.toContain(undatedEdge);
    fx.setNow(new Date('2026-09-01T00:00:00.000Z'));
  });

  it('never escalates a collective edge with neither coordinator nor children (§4.7)', () => {
    const edge = collective(null, []);
    const verification = verifyAssertionChain(edge, []);
    expect(verification.unverifiable).toBe(true);
    expect(mayAutoEscalate(edge, verification, new Date('2026-09-01T00:00:00Z'))).toBe(false);
  });

  it('a verifiable collective edge is not blocked by this rule', () => {
    const edge = collective(persona(100).personaId, []);
    const verification = verifyAssertionChain(edge, []);
    expect(verification.unverifiable).toBe(false);
    // Still not escalatable here, but for the ordinary reason: it is not open.
    expect(verification.final_state).toBe('none');
  });

  it('does not escalate an edge that has already resolved', () => {
    const released = fx.node.commit({
      intent: 'to be released',
      owed_to: fx.personas[1]!,
      due: '2026-08-01T00:00:00Z',
      persona: null,
      propose: true,
    }).edge_id!;
    syncEdge(fx, 0, 1, released);
    nodeAs(fx, 1).confirm({ id: released, decision: 'confirm' });
    syncEdge(fx, 1, 0, released);
    expect(fx.node.escalatable(fx.personas[0]!)).toContain(released);

    // owed_to forgives it; escalation stops. §4.3 `open → released` is asserted by owed_to
    // alone; signed here directly because release reaches the wire through a client action,
    // not through one of the six §7 tools.
    const forgiveness = withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'assertion' as const,
        edge_id: released,
        state: 'released' as const,
        asserted_at: fx.now.toISOString(),
        by: fx.personas[1]!,
        evidence_hash: null,
      },
      persona(1).privateKey,
    ) as Assertion;
    fx.vault.appendAssertion(fx.personas[0]!, forgiveness);
    expect(fx.node.edgeState(fx.personas[0]!, released).final_state).toBe('released');
    expect(fx.node.escalatable(fx.personas[0]!)).not.toContain(released);
  });
});
