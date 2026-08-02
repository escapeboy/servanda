import type { EffectiveState } from '@servanda/types';
import { TERMINAL_STATES } from '@servanda/types';
import type { Vault } from './vault.js';

/**
 * §5.4 / M-15 — retention decay. "Remember that, not what."
 *
 * After the owner-configured window, the commitment PLAINTEXT is deleted and the edge plus its
 * full assertion chain are preserved. What survives is a signed, hash-only record that the
 * promise existed and how it ended.
 *
 * **What this does NOT do, stated because it used to claim otherwise.** This file said "what does
 * not survive is what it said", and that was false. The vault is a git repository, so deleting a
 * record writes a commit that removes it from the working tree while the sealed blob stays in
 * history — under the same content key, since there is only one. `git show HEAD~1:<path>` plus the
 * passphrase returns the exact intent string. Retention removes the record from the vault's
 * present, not from its past.
 *
 * The conflict is structural rather than a bug to patch: an append-only store and a forgetting
 * requirement are opposite properties, and no arrangement of records inside git resolves it —
 * whatever key opens a blob must itself be somewhere git cannot keep. So the honest reading is
 * that M-15's "SHOULD be deleted" is met against a reader of the vault, and is not met against a
 * reader of the repository. §5.4 says which, and `deleteCommitmentPlaintext` says it again at the
 * call site rather than trusting anyone to have read this.
 *
 * The pass only ever touches edges in a terminal state (§5.4 names closed/expired/released/
 * superseded — exactly `TERMINAL_STATES`). An open edge's plaintext is never a retention
 * candidate, however old it is.
 *
 * **And one plaintext store is outside this pass entirely: the pending-extraction queue.**
 * `queuePendingExtraction` seals a whole `Commitment`, `intent` and all, under
 * `personas/<p>/pending/`, and nothing here iterates it — this walks `listEdgeIds`. A candidate
 * the user never confirmed and never dismissed sits there for the life of the vault.
 *
 * That is not a breach of M-15, which scopes retention to terminal EDGES and to nothing else, and
 * it is not silently a feature either: the queue holds the most speculative content in the system,
 * extracted without anyone agreeing to it, and "we keep it until you act" is a policy somebody
 * should choose rather than inherit. Named here because the retention story reads as complete
 * without it, which is how an unbounded store stays unnoticed.
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
