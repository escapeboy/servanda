import { describe, expect, it } from 'vitest';
import { Edge, PROTOCOL_VERSION } from '@servanda/types';
import { isCollectiveEdgeVerifiable, verifyAssertionChain } from '../../src/transitions.js';
import { persona } from '../support/fixture.js';

/**
 * M-9 — Collective edges require covering decomposition or a named coordinator.
 * §4.7: "a collective edge MUST have either `fulfillment.children` whose union covers
 * fulfillment, or `fulfillment.coordinator`. Otherwise nodes MUST mark it unverifiable."
 *
 * Owned by this layer.
 *
 * NARROW READING (reported): "whose union covers fulfillment" is not defined in terms a node
 * can check for `all`/`any` without inventing semantics. The narrowest checkable reading is
 * used: children must be non-empty, and under `k-of-n` there must be a k the children can
 * actually satisfy. Anything looser would let an empty decomposition pass as covering.
 */

function collectiveEdge(fulfillment: Record<string, unknown> | undefined): Edge {
  return Edge.parse({
    v: PROTOCOL_VERSION,
    type: 'edge',
    edge_id: 'a'.repeat(64),
    commitment_hash: 'b'.repeat(64),
    owner: persona(2).personaId, // stands in for a group key: §1.4 gives it the same shape
    owed_to: persona(7).personaId,
    proposed_at: '2026-07-01T00:00:00Z',
    due: null,
    closure_policy: 'on-acceptance',
    acceptance_window: 'P5D',
    blocked_by: [],
    ...(fulfillment ? { fulfillment } : {}),
    supersedes: null,
  });
}

const CHILD_A = 'c'.repeat(64);
const CHILD_B = 'd'.repeat(64);

describe('M-9: collective edges require decomposition or a coordinator', () => {
  it('a non-collective edge is unaffected', () => {
    expect(isCollectiveEdgeVerifiable(collectiveEdge(undefined))).toBe(true);
  });

  it('accepts a named coordinator with no children', () => {
    expect(
      isCollectiveEdgeVerifiable(
        collectiveEdge({ policy: 'all', children: [], coordinator: persona(100).personaId }),
      ),
    ).toBe(true);
  });

  it('accepts a covering decomposition with no coordinator', () => {
    expect(
      isCollectiveEdgeVerifiable(collectiveEdge({ policy: 'all', children: [CHILD_A, CHILD_B] })),
    ).toBe(true);
  });

  it('marks a collective edge with neither as unverifiable', () => {
    const edge = collectiveEdge({ policy: 'all', children: [] });
    expect(isCollectiveEdgeVerifiable(edge)).toBe(false);
    expect(verifyAssertionChain(edge, []).unverifiable).toBe(true);
  });

  it('rejects a k-of-n decomposition its children cannot satisfy', () => {
    expect(
      isCollectiveEdgeVerifiable(collectiveEdge({ policy: 'k-of-n', k: 3, children: [CHILD_A, CHILD_B] })),
    ).toBe(false);
    expect(
      isCollectiveEdgeVerifiable(collectiveEdge({ policy: 'k-of-n', children: [CHILD_A, CHILD_B] })),
    ).toBe(false);
    expect(
      isCollectiveEdgeVerifiable(collectiveEdge({ policy: 'k-of-n', k: 2, children: [CHILD_A, CHILD_B] })),
    ).toBe(true);
  });
});
