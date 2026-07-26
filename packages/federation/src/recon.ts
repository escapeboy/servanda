import { hashCanonical } from '@servanda/crypto';
import { verifyAssertionChain } from '@servanda/node';
import type { Assertion, Edge, EffectiveState, RejectionReason } from '@servanda/types';
import type { Vault } from '@servanda/vault';
import { isParty, mayServeEdge } from './serve.js';

/**
 * §6.4 reconciliation — "periodic pairwise sync between nodes sharing edges".
 *
 * The load-bearing sentence is the third bullet: "Divergence in *state* is resolved by the
 * transition table — assertions invalid per §4.3 are discarded; the valid chain wins."
 *
 * So this module decides NOTHING about state. Every candidate assertion arriving over the wire
 * is fed to `verifyAssertionChain` from @servanda/node — the same function the local node uses
 * on its own assertions — and whatever that function rejects is discarded (M-14). There is no
 * merge rule, no last-writer-wins, no timestamp arbitration here, because inventing one would
 * put a second authority over edge state next to the transition table.
 *
 * The fourth bullet is equally load-bearing in the negative: "Escalation on drift is a local
 * decision of the owner's node… reconciliation only guarantees both sides see the same chain."
 * Nothing here escalates, nudges, or notifies.
 */

/** §6.4: `recon_request` covers "all shared open edges". */
const OPEN_FAMILY: readonly EffectiveState[] = ['proposed', 'open', 'pending-acceptance', 'disputed'] as const;

export interface ReconEdgeRef {
  edge_id: string;
  latest_assertion_hash: string;
}

export interface ReconRequest {
  edges: ReconEdgeRef[];
}

export interface ReconResponse {
  edges: { edge_id: string; assertions: Assertion[] }[];
}

export interface DiscardedAssertion {
  edge_id: string;
  /** Index within the candidate chain the transition table evaluated. */
  index: number;
  reason: RejectionReason;
}

export interface ReconApplyResult {
  /** Assertions accepted by the transition table and written to the vault. */
  accepted: Assertion[];
  /** Assertions the transition table rejected. They were never applied (M-14). */
  discarded: DiscardedAssertion[];
  /** Edge ids named in the response that this vault does not hold, or is not a party to. */
  ignored: string[];
}

/**
 * The hash a peer compares against. §6.4 names `latest_assertion_hash` without defining it;
 * narrowest reading: the canonical hash (§00 signing rule's preimage function) of the last
 * assertion this node holds for the edge. An empty chain has no latest assertion, and is
 * represented by the all-zero hash so the field can stay a required Sha256Hex.
 */
export const EMPTY_CHAIN_HASH = '0'.repeat(64);

export function latestAssertionHash(assertions: Assertion[]): string {
  const last = assertions[assertions.length - 1];
  return last === undefined ? EMPTY_CHAIN_HASH : hashCanonical(last as unknown as Record<string, unknown>);
}

/** Edges this persona shares with `counterparty` that are still live (§6.4 "shared open edges"). */
export function sharedOpenEdges(vault: Vault, persona: string, counterparty: string): Edge[] {
  const out: Edge[] = [];
  for (const id of vault.listEdgeIds(persona)) {
    const edge = vault.getEdge(persona, id);
    if (!edge || !isParty(edge, persona) || !isParty(edge, counterparty)) continue;
    const state = verifyAssertionChain(edge, vault.getAssertions(persona, id)).final_state;
    if (OPEN_FAMILY.includes(state)) out.push(edge);
  }
  return out;
}

export function buildReconRequest(vault: Vault, persona: string, counterparty: string): ReconRequest {
  return {
    edges: sharedOpenEdges(vault, persona, counterparty).map((edge) => ({
      edge_id: edge.edge_id,
      latest_assertion_hash: latestAssertionHash(vault.getAssertions(persona, edge.edge_id)),
    })),
  };
}

/**
 * Answer a peer's `recon_request` with "missing assertions for divergent chains".
 *
 * Two rules decide what leaves this node:
 *  - M-4a via `mayServeEdge` — an edge is never served to a non-party, non-scope-member, even
 *    when the requester somehow knows its edge_id. Knowing an id is not being entitled to it.
 *  - convergence — when the peer's `latest_assertion_hash` equals ours there is nothing to send.
 *
 * We cannot know WHICH assertions the peer lacks (the request carries one hash, not a set), so
 * a divergent chain is answered in full and the applier deduplicates. That is a superset, never
 * a subset: the guarantee §6.4 makes is that both sides end up seeing the same chain.
 */
export function answerReconRequest(
  vault: Vault,
  persona: string,
  requester: string,
  request: ReconRequest,
): ReconResponse {
  const edges: ReconResponse['edges'] = [];
  for (const ref of request.edges) {
    const edge = vault.getEdge(persona, ref.edge_id);
    if (!edge) continue;
    if (!mayServeEdge(vault, persona, requester, edge).serve) continue;
    const assertions = vault.getAssertions(persona, ref.edge_id);
    if (latestAssertionHash(assertions) === ref.latest_assertion_hash) continue;
    edges.push({ edge_id: ref.edge_id, assertions });
  }
  return { edges };
}

/**
 * Apply a `recon_response`. Every incoming assertion is evaluated by the transition table in
 * the context of the chain this node already holds; only the accepted ones are stored.
 *
 * Ordering: incoming assertions are appended after the local chain, sorted by `asserted_at`
 * with `sig` as the tie-break. A deterministic order matters because the transition table is
 * order-sensitive, and a peer that could choose our evaluation order could choose our state.
 */
export function applyReconResponse(vault: Vault, persona: string, response: ReconResponse): ReconApplyResult {
  const result: ReconApplyResult = { accepted: [], discarded: [], ignored: [] };

  for (const entry of response.edges) {
    const edge = vault.getEdge(persona, entry.edge_id);
    // Reconciliation never introduces an edge. §6.4 exchanges assertions between nodes that
    // already share the edge; a new edge arrives as a `propose` and is admitted by the inbox,
    // where the anti-spam budget (§6.5) applies.
    if (!edge || !isParty(edge, persona)) {
      result.ignored.push(entry.edge_id);
      continue;
    }

    const local = vault.getAssertions(persona, entry.edge_id);
    const held = new Set(local.map((a) => a.sig));
    const incoming = entry.assertions
      .filter((a) => !held.has(a.sig))
      .sort((x, y) => Date.parse(x.asserted_at) - Date.parse(y.asserted_at) || x.sig.localeCompare(y.sig));
    if (incoming.length === 0) continue;

    const candidate = [...local, ...incoming];
    const { outcomes } = verifyAssertionChain(edge, candidate);
    for (let i = 0; i < incoming.length; i++) {
      const assertion = incoming[i]!;
      const outcome = outcomes[local.length + i]!;
      if (outcome.accepted) {
        vault.appendAssertion(persona, assertion);
        result.accepted.push(assertion);
      } else {
        result.discarded.push({
          edge_id: entry.edge_id,
          index: outcome.index,
          reason: outcome.rejection_reason!,
        });
      }
    }
  }

  return result;
}
