import type { Edge } from '@servanda/types';
import type { ChainVerification } from './transitions.js';

/**
 * M-8 + §3.1 — when a node may escalate an edge on its own initiative.
 *
 * Two absolute bars, both phrased as MUST NOT in the spec:
 *  - §3.1: "Undated commitments MUST NOT time-escalate." No `due`, no escalation, ever,
 *    however old the edge is. Undated items rank by age × blocking instead (see brief.ts).
 *  - §4.3 / §4.7 / M-8: an unverifiable edge — a collective edge with neither a covering
 *    decomposition nor a named coordinator — MUST NOT auto-escalate. The system has an
 *    opinion only where it has evidence.
 *
 * This governs the NODE's own initiative. It does not govern an `expired` assertion a party
 * signs deliberately: that is a human act, and §4.3 admits it (the transition table checks it).
 */
export function mayAutoEscalate(
  edge: Edge,
  verification: ChainVerification,
  now: Date,
): boolean {
  if (edge.due === null) return false;
  if (verification.unverifiable) return false;
  if (verification.final_state !== 'open' && verification.final_state !== 'pending-acceptance') {
    return false;
  }
  return now.getTime() > Date.parse(edge.due);
}
