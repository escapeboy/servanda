import type { EffectiveState } from '@servanda/types';
import { TERMINAL_STATES } from '@servanda/types';
import type { Vault } from './vault.js';

/**
 * §5.4 / M-15 — retention decay. "Remember that, not what."
 *
 * After the owner-configured window, the commitment PLAINTEXT is deleted and the edge plus its
 * full assertion chain are preserved. What survives is a signed, hash-only record that the
 * promise existed and how it ended; what does not survive is what it said.
 *
 * The pass only ever touches edges in a terminal state (§5.4 names closed/expired/released/
 * superseded — exactly `TERMINAL_STATES`). An open edge's plaintext is never a retention
 * candidate, however old it is.
 */

export interface RetentionCandidate {
  edge_id: string;
  commitment_hash: string;
  state: EffectiveState;
  /** When the terminal assertion landed — the clock the window runs from. */
  resolved_at: string;
}

export interface RetentionResult {
  /** commitment_hash values whose plaintext was deleted. */
  deleted_plaintext: string[];
  /** edge_ids whose edge + assertion chain were kept. Always a superset of the above. */
  preserved_edges: string[];
  /** Terminal edges still inside the window. */
  skipped_within_window: string[];
}

/**
 * State-resolution is the node's job (§4.3), so the caller supplies it. Keeping the transition
 * table out of the vault is deliberate: L0 stores, L1 decides.
 */
export type EdgeStateResolver = (persona: string, edgeId: string) => {
  state: EffectiveState;
  resolved_at: string | null;
};

export function runRetention(
  vault: Vault,
  persona: string,
  resolve: EdgeStateResolver,
  opts: { now?: Date; retentionDays?: number } = {},
): RetentionResult {
  const now = opts.now ?? new Date();
  const retentionDays = opts.retentionDays ?? vault.retentionPolicy().retention_days;
  const windowMs = retentionDays * 86_400_000;

  const result: RetentionResult = {
    deleted_plaintext: [],
    preserved_edges: [],
    skipped_within_window: [],
  };

  for (const edgeId of vault.listEdgeIds(persona)) {
    const edge = vault.getEdge(persona, edgeId);
    if (!edge) continue;
    // MUST: the edge and its chain are preserved unconditionally. Nothing below deletes them.
    result.preserved_edges.push(edgeId);

    const { state, resolved_at } = resolve(persona, edgeId);
    if (!TERMINAL_STATES.includes(state) || resolved_at === null) continue;

    if (now.getTime() - Date.parse(resolved_at) < windowMs) {
      result.skipped_within_window.push(edgeId);
      continue;
    }

    if (vault.deleteCommitmentPlaintext(persona, edge.commitment_hash)) {
      result.deleted_plaintext.push(edge.commitment_hash);
      vault.putEdgeMeta(persona, {
        edge_id: edgeId,
        dismissed: vault.getEdgeMeta(persona, edgeId).dismissed,
        plaintext_deleted_at: now.toISOString(),
      });
    }
  }

  return result;
}
