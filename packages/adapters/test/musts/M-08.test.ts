import { describe, expect, it } from 'vitest';
import { mayAutoEscalate as nodeMayAutoEscalate, verifyAssertionChain } from '@servanda/node';
import { isEdgeVerifiable, mayAutoEscalate, verifyCommitment } from '../../src/verify.js';
import {
  assertion,
  commitment,
  edge,
  NOW,
  OWED_TO,
  OWNER,
  REPO,
  REPO_HEAD,
} from '../support/fixture.js';

/**
 * M-8 — "Unverifiable edges (no adapter, or invalid collective) MUST NOT auto-escalate."
 *
 * `@servanda/node` owns the half it can see: no `due`, not live, invalid collective. This layer
 * owns the half nothing else can — whether an adapter exists at all — and the interpretation
 * recorded in `verify.ts`: the "no adapter" bar binds an `on-evidence` edge, whose §4.4 closure
 * *is* an adapter's bundle, and does not bind an `on-acceptance` edge, which closes on the
 * counterparty's act. Both halves are pinned below, including the one that must NOT fire.
 */

const LIVE = new Date('2026-08-01T00:00:00Z'); // past the fixture edge's due of 2026-07-20
const repoCtx = { now: NOW, repo: { path: REPO } };

/** proposed → confirmed, i.e. an open edge with both signatures across the chain. */
function openChain(edge_id: string) {
  return [
    assertion({
      edge_id,
      state: 'proposed',
      by: OWNER,
      asserted_at: '2026-07-01T09:00:00Z',
      evidence_hash: null,
    }),
    assertion({
      edge_id,
      state: 'confirmed',
      by: OWED_TO,
      asserted_at: '2026-07-01T10:00:00Z',
      evidence_hash: null,
    }),
  ];
}

function verdicts(e: ReturnType<typeof edge>, refs: Parameters<typeof commitment>[0]) {
  const chain = verifyAssertionChain(e, openChain(e.edge_id));
  const outcome = verifyCommitment(commitment(refs), { ...repoCtx, edge: e });
  return {
    chain,
    outcome,
    nodeVerdict: nodeMayAutoEscalate(e, chain, LIVE),
    composed: mayAutoEscalate({
      edge: e,
      outcome,
      nodeVerdict: nodeMayAutoEscalate(e, chain, LIVE),
    }),
  };
}

describe('M-8: unverifiable edges MUST NOT auto-escalate', () => {
  it('an overdue on-evidence edge WITH an adapter escalates — the bar is not "always false"', () => {
    const v = verdicts(edge({ closure_policy: 'on-evidence' }), [
      { kind: 'commit', value: REPO_HEAD },
    ]);
    expect(v.chain.final_state).toBe('open');
    expect(v.outcome.verifiable).toBe(true);
    expect(v.nodeVerdict).toBe(true);
    expect(v.composed).toBe(true);
  });

  it('an on-evidence edge no adapter can speak to never escalates', () => {
    // A url is the honest case: the promise names evidence that exists, and observing it would
    // need the network. §4.4 gives this edge no way to close, so nothing may nag about it.
    const e = edge({ closure_policy: 'on-evidence' });
    const v = verdicts(e, [{ kind: 'url', value: 'https://forge.example/pr/1' }]);
    expect(v.outcome.verifiable).toBe(false);
    expect(v.nodeVerdict).toBe(true); // the node alone would have escalated it
    expect(isEdgeVerifiable(e, v.outcome)).toBe(false);
    expect(v.composed).toBe(false);
  });

  it('an on-evidence edge naming no evidence at all never escalates', () => {
    const e = edge({ closure_policy: 'on-evidence' });
    const v = verdicts(e, []);
    expect(v.outcome.verifiable).toBe(false);
    expect(v.composed).toBe(false);
  });

  it('an on-acceptance edge with no adapter still escalates (scenario 4)', () => {
    // Mila owes Stefan staging data. No adapter on earth verifies that, and §4.4 makes
    // on-acceptance the default for cross-person edges. If M-8 silenced this, the product
    // would have no escalation at all.
    const e = edge({ closure_policy: 'on-acceptance', acceptance_window: 'P5D' });
    const v = verdicts(e, []);
    expect(v.outcome.verifiable).toBe(false);
    expect(isEdgeVerifiable(e, v.outcome)).toBe(true);
    expect(v.composed).toBe(true);
  });

  it('an invalid collective edge never escalates, whatever its closure policy or evidence', () => {
    for (const closure_policy of ['on-evidence', 'on-acceptance'] as const) {
      const e = edge({
        closure_policy,
        acceptance_window: closure_policy === 'on-acceptance' ? 'P5D' : null,
        fulfillment: { policy: 'all', children: [] },
      });
      const v = verdicts(e, [{ kind: 'commit', value: REPO_HEAD }]);
      // The evidence is real and the promise was kept; the edge is still unverifiable, because
      // nothing says whose fulfillment it names (§4.7).
      expect(v.outcome.verifiable, closure_policy).toBe(false);
      expect(v.chain.unverifiable, closure_policy).toBe(true);
      expect(isEdgeVerifiable(e, v.outcome), closure_policy).toBe(false);
      expect(v.composed, closure_policy).toBe(false);
    }
  });

  it('a collective edge with a coordinator is not blocked by this rule', () => {
    const e = edge({
      fulfillment: { policy: 'all', children: [], coordinator: OWED_TO.personaId },
    });
    const v = verdicts(e, [{ kind: 'commit', value: REPO_HEAD }]);
    expect(v.chain.unverifiable).toBe(false);
    expect(v.composed).toBe(true);
  });

  it('the composition can only ever narrow the node, never widen it', () => {
    const e = edge({ due: null, closure_policy: 'on-evidence' });
    const v = verdicts(e, [{ kind: 'commit', value: REPO_HEAD }]);
    // §3.1: undated commitments MUST NOT time-escalate. Verifiable evidence does not unlock it.
    expect(v.outcome.verifiable).toBe(true);
    expect(v.nodeVerdict).toBe(false);
    expect(v.composed).toBe(false);
  });
});
