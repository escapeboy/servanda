import type { Edge } from '@servanda/types';

/**
 * §4.7 + M-9: "a collective edge MUST have either `fulfillment.children` whose union covers
 * fulfillment, or `fulfillment.coordinator`. Otherwise nodes MUST mark it unverifiable (no
 * auto-escalation)."
 *
 * This is deliberately a mirror of `isCollectiveEdgeVerifiable` in `@servanda/node`, not an
 * import: `@servanda/node` is the consumer of this package, and a dependency in the other
 * direction would close a cycle. The mirror is not left to trust — `test/musts/M-09.test.ts`
 * asserts the two agree across a table of edges, so a change to either that drifts from the
 * other fails the gate rather than being discovered later.
 *
 * RECOMMENDED (orchestrator): hoist this predicate into `@servanda/types` alongside the `Edge`
 * schema it is a property of, and have both packages import the one copy.
 *
 * "Covers fulfillment" is not defined in checkable terms for `all`/`any`; the narrowest reading
 * a node can enforce without inventing semantics is: children must be non-empty, and under
 * `k-of-n` there must be a k the children could actually satisfy.
 */
export function collectiveDecompositionValid(edge: Edge): boolean {
  const f = edge.fulfillment;
  if (!f) return true; // not a collective edge
  if (f.coordinator) return true;
  if (f.children.length === 0) return false;
  if (f.policy === 'k-of-n') return f.k !== undefined && f.k > 0 && f.k <= f.children.length;
  return true;
}
