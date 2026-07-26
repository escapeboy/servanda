import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Edge } from '@servanda/types';
import { M11Violation, ServandaNode } from '../../src/node.js';
import * as nodeApi from '../../src/index.js';
import { makeFixture, nodeAs, persona, syncEdge, type Fixture } from '../support/fixture.js';

/**
 * M-11 — No network-level reputation: nodes and hubs MUST NOT compute, store, or serve
 * cross-party fulfillment statistics; clients MAY display only local pairwise history.
 *
 * Owned by this layer (node) and by the hub (Stream B) on the serving side.
 */

let fx: Fixture;
let closedEdge: string;

beforeAll(() => {
  fx = makeFixture();
  closedEdge = fx.node.commit({
    intent: 'a promise that gets kept',
    owed_to: fx.personas[1]!,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  syncEdge(fx, 0, 1, closedEdge);
  nodeAs(fx, 1).confirm({ id: closedEdge, decision: 'confirm' });
  syncEdge(fx, 1, 0, closedEdge);
});
afterAll(() => fx.cleanup());

describe('M-11: no cross-party fulfillment statistics', () => {
  it('local pairwise history counts only edges the persona is a party to', () => {
    const history = fx.node.localPairwiseHistory(fx.personas[0]!, fx.personas[1]!);
    expect(history.open).toBe(1);
    expect(history.closed).toBe(0);
    // And nothing about a pair this persona is not in.
    expect(fx.node.localPairwiseHistory(fx.personas[0]!, persona(2).personaId)).toEqual({
      closed: 0,
      released: 0,
      expired: 0,
      disputed: 0,
      open: 0,
    });
  });

  it('refuses to compute over an edge the requesting persona is not a party to', () => {
    // Simulate a third-party edge arriving in the persona's subtree (e.g. via a scope sync).
    const a = persona(2);
    const b = persona(7);
    const thirdParty: Edge = {
      v: PROTOCOL_VERSION,
      type: 'edge',
      edge_id: 'e'.repeat(64),
      commitment_hash: 'f'.repeat(64),
      owner: a.personaId,
      owed_to: b.personaId,
      proposed_at: '2026-07-01T00:00:00Z',
      due: null,
      closure_policy: 'on-acceptance',
      acceptance_window: 'P5D',
      blocked_by: [],
      supersedes: null,
    };
    fx.vault.putEdge(fx.personas[0]!, thirdParty);
    expect(() => fx.node.localPairwiseHistory(fx.personas[0]!, b.personaId)).toThrow(M11Violation);
  });

  it('exposes no aggregate, rate, ranking or score API', () => {
    const surface = [
      ...Object.keys(nodeApi),
      ...Object.getOwnPropertyNames(ServandaNode.prototype),
    ];
    const forbidden = /reputation|fulfillment_?rate|reliability|trust_?score|leaderboard|aggregate/i;
    expect(surface.filter((n) => forbidden.test(n))).toEqual([]);
  });

  it('no tool output carries a counterparty statistic', () => {
    const loops = fx.node.openLoops({ view: 'all', persona: null, limit: 50 });
    for (const item of loops.items) {
      // §7's item shape is the whole contract; a statistic would have to be a new field.
      expect(Object.keys(item).sort()).toEqual([
        'actions',
        'age_days',
        'counterparty',
        'due',
        'id',
        'intent_or_expect',
        'kind',
        'state',
        'verification_level',
      ]);
    }
    const brief = fx.node.brief({ persona: null });
    expect(JSON.stringify(brief)).not.toMatch(
      /\b(reputation|reliability|fulfillment[_ -]?rate|trust[_ -]?score|success[_ -]?rate)\b/i,
    );
  });

  it('verification level is evidence about a key, not a judgement about a person', () => {
    // §1.6 level 1 is "≥1 prior confirmed edge with this key" — a fact about this pair's own
    // history, not a statistic aggregated across the network.
    expect(fx.node.verificationLevel(fx.personas[0]!, fx.personas[1]!)).toBe('1');
    expect(fx.node.verificationLevel(fx.personas[0]!, persona(100).personaId)).toBe('0');
    // Signing more edges with the same key never raises it beyond what the evidence supports.
    const another = fx.node.commit({
      intent: 'another',
      owed_to: fx.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    }).edge_id!;
    syncEdge(fx, 0, 1, another);
    expect(fx.node.verificationLevel(fx.personas[0]!, fx.personas[1]!)).toBe('1');
    expect(withSignature).toBeTypeOf('function');
  });
});
