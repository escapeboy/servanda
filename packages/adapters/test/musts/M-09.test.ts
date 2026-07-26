import { describe, expect, it } from 'vitest';
import { isCollectiveEdgeVerifiable } from '@servanda/node';
import type { Fulfillment } from '@servanda/types';
import { collectiveDecompositionValid } from '../../src/collective.js';
import { verifyCommitment } from '../../src/verify.js';
import { commitment, edge, NOW, OWED_TO, REPO, REPO_HEAD } from '../support/fixture.js';

/**
 * M-9 — "Collective edges require covering decomposition or a named coordinator."
 * §4.7: "Otherwise nodes MUST mark it unverifiable (no auto-escalation)."
 *
 * The adapter layer is where "unverifiable" becomes a value a caller holds, so the rule is
 * enforced here as well as in the transition layer. Both names now resolve to the single
 * implementation in `@servanda/types`; the last test is what keeps it that way, failing the
 * moment either package answers from a local copy again.
 */

const CHILD = 'e'.repeat(64);

const TABLE: { name: string; fulfillment: Fulfillment | undefined; valid: boolean }[] = [
  { name: 'not a collective edge at all', fulfillment: undefined, valid: true },
  { name: 'a named coordinator, no children', fulfillment: { policy: 'all', children: [], coordinator: OWED_TO.personaId }, valid: true },
  { name: 'a named coordinator and children', fulfillment: { policy: 'all', children: [CHILD], coordinator: OWED_TO.personaId }, valid: true },
  { name: 'children under "all"', fulfillment: { policy: 'all', children: [CHILD] }, valid: true },
  { name: 'children under "any"', fulfillment: { policy: 'any', children: [CHILD] }, valid: true },
  { name: 'neither children nor coordinator', fulfillment: { policy: 'all', children: [] }, valid: false },
  { name: 'no children under "any"', fulfillment: { policy: 'any', children: [] }, valid: false },
  { name: 'k-of-n with a satisfiable k', fulfillment: { policy: 'k-of-n', k: 1, children: [CHILD] }, valid: true },
  { name: 'k-of-n with k larger than n', fulfillment: { policy: 'k-of-n', k: 2, children: [CHILD] }, valid: false },
  { name: 'k-of-n with no k', fulfillment: { policy: 'k-of-n', children: [CHILD] }, valid: false },
  { name: 'k-of-n with no children', fulfillment: { policy: 'k-of-n', k: 1, children: [] }, valid: false },
];

describe('M-9: collective edges require covering decomposition or a named coordinator', () => {
  for (const row of TABLE) {
    it(`${row.valid ? 'accepts' : 'refuses'}: ${row.name}`, () => {
      const e = edge(row.fulfillment ? { fulfillment: row.fulfillment } : {});
      expect(collectiveDecompositionValid(e)).toBe(row.valid);
    });
  }

  it('reports an invalid collective as NotVerifiable before any adapter runs', () => {
    // The evidence is real and would satisfy on its own. It is never reached: an edge whose
    // fulfillment names nobody cannot be verified by observing anything.
    const e = edge({ fulfillment: { policy: 'all', children: [] } });
    const outcome = verifyCommitment(commitment([{ kind: 'commit', value: REPO_HEAD }]), {
      now: NOW,
      repo: { path: REPO },
      edge: e,
    });
    expect(outcome.verifiable).toBe(false);
    if (outcome.verifiable) throw new Error('unreachable');
    expect(outcome.reason).toBe('collective-without-decomposition-or-coordinator');
    expect(outcome.evidence_hash).toBeNull();
  });

  it('answers identically to @servanda/node on every row — one rule, not two', () => {
    for (const row of TABLE) {
      const e = edge(row.fulfillment ? { fulfillment: row.fulfillment } : {});
      expect(collectiveDecompositionValid(e), row.name).toBe(isCollectiveEdgeVerifiable(e));
    }
  });
});
