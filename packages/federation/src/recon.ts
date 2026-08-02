import { z } from 'zod';
import { hashCanonical } from '@servanda/crypto';
import { verifyAssertionChain } from '@servanda/node';
import type { Assertion, Edge, EffectiveState, RejectionReason } from '@servanda/types';
import { Assertion as AssertionSchema, PROTOCOL_VERSION, Sha256Hex } from '@servanda/types';
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

/**
 * §6.2 gives a wire payload no shape at all (`payload: z.unknown()`), so these are the schemas
 * that turn attacker-chosen bytes into the types below. They are the payload's only shape check
 * — a `recon_request` whose `edges` is a string used to reach the responder as one, and a
 * `recon_response` whose `edges` was missing threw out of ingestion, taking the rest of the
 * delivery with it. The inbox parses with these before either type is read.
 */
export const ReconEdgeRefSchema = z.object({
  edge_id: Sha256Hex,
  latest_assertion_hash: Sha256Hex,
});
export const ReconRequestSchema = z.object({ edges: z.array(ReconEdgeRefSchema) });
export const ReconResponseSchema = z.object({
  edges: z.array(z.object({ edge_id: Sha256Hex, assertions: z.array(AssertionSchema) })),
});

export type ReconEdgeRef = z.infer<typeof ReconEdgeRefSchema>;
export type ReconRequest = z.infer<typeof ReconRequestSchema>;
export type ReconResponse = z.infer<typeof ReconResponseSchema>;

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
 * The hash a peer compares against. §6.4 names `latest_assertion_hash` and does not define it.
 *
 * The narrow reading — the canonical hash of the LAST assertion held — is what this was, and it
 * does not converge. The question the hash exists to answer is "do we hold the same assertions?",
 * which is a question about a SET; the last element of a sequence answers a different one. Two
 * honest nodes that each signed their own act and then received the other's hold identical sets in
 * opposite orders, so they reported different hashes forever: every round each side re-offered a
 * chain the other already had and deduplicated, and reconciliation never reached "nothing to send".
 *
 * So it is a set hash: every assertion's `sig` sorted, then digested. Sorting by `sig` rather than
 * by `asserted_at` because `sig` is unique per assertion and is not a value either party chooses —
 * `asserted_at` is written by the party it would order, which §4.3 already had to fix once.
 *
 * This deliberately says nothing about ORDER, and it should not: order is what the transition
 * table consumes, and two nodes holding the same set can still disagree about state. That is a
 * separate guarantee, kept by `inWireOrder` normalising every batch and by §4.3 naming a state for
 * the case where two legal acts genuinely conflict.
 *
 * An empty chain is the all-zero hash, so the field stays a required Sha256Hex.
 */
export const EMPTY_CHAIN_HASH = '0'.repeat(64);

export function latestAssertionHash(assertions: Assertion[]): string {
  if (assertions.length === 0) return EMPTY_CHAIN_HASH;
  const sigs = assertions.map((a) => a.sig).sort();
  return hashCanonical({ v: PROTOCOL_VERSION, type: 'chain_digest', sigs } as unknown as Record<string, unknown>);
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
 * The order a responder's assertions are evaluated in.
 *
 * The transition table is order-sensitive, so whoever chooses the order chooses the outcome:
 * replay an honest `[proposed, confirmed]` back-to-front and `confirmed` has no legal source
 * state, so it is dropped and the edge settles at `proposed`. Normalising by `asserted_at` takes
 * that choice away from a sender whose timestamps are ordered. Both §6.4 and §6.6 appliers use
 * this — the divergence between them WAS the bug, so there is one comparator rather than two.
 *
 * There is deliberately NO tie-break, and the sort must be a stable one. §4.2 assertions carry no
 * `prev` link, so `asserted_at` is the only causal signal on the wire and two assertions made in
 * the same second are common (a propose and its confirmation inside one clock tick tie in every
 * fixture here). Breaking those ties by `sig` — as this did — orders them by signature bytes,
 * which is causally meaningless: it dropped `confirmed` from perfectly honest chains on roughly
 * half of all edges, decided by a hash. Worse, `sig` follows content, so a party willing to grind
 * the sub-second digits of its own `asserted_at` could pick which of two same-instant assertions
 * sorted first, i.e. choose the outcome the tie-break was supposed to deny it. A stable sort
 * leaves tied assertions in the order the sender listed them, which for an honest peer IS its
 * causal chain — the best signal that exists — and for a hostile one is a divergence §6.4 heals
 * on the next exchange, since a rejected assertion is never stored and is re-offered.
 */
export function inWireOrder(a: Assertion, b: Assertion): number {
  return Date.parse(a.asserted_at) - Date.parse(b.asserted_at);
}

/**
 * Apply a `recon_response` from `responder`. Every incoming assertion is evaluated by the
 * transition table in the context of the chain this node already holds; only the accepted ones
 * are stored.
 *
 * §6.4 calls reconciliation "pairwise sync between nodes sharing edges", so BOTH ends are
 * checked: this persona must be a party, and so must the responder. Only checking our own side
 * let any persona that could reach us push a chain for an edge it has no part in — every
 * assertion still had to be signed and legal, but "who may hand me a chain for this edge" is a
 * separate question from "is this chain well-formed", and it was going unasked.
 */
export function applyReconResponse(
  vault: Vault,
  persona: string,
  responder: string,
  response: ReconResponse,
): ReconApplyResult {
  const result: ReconApplyResult = { accepted: [], discarded: [], ignored: [] };

  for (const entry of response.edges) {
    const edge = vault.getEdge(persona, entry.edge_id);
    // Reconciliation never introduces an edge. §6.4 exchanges assertions between nodes that
    // already share the edge; a new edge arrives as a `propose` and is admitted by the inbox,
    // where the anti-spam budget (§6.5) applies.
    if (!edge || !isParty(edge, persona) || !isParty(edge, responder)) {
      result.ignored.push(entry.edge_id);
      continue;
    }

    const local = vault.getAssertions(persona, entry.edge_id);
    const held = new Set(local.map((a) => a.sig));
    const incoming = entry.assertions.filter((a) => !held.has(a.sig)).sort(inWireOrder);
    if (incoming.length === 0) continue;

    const candidate = [...local, ...incoming];
    const { outcomes } = verifyAssertionChain(edge, candidate, vault.now());
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
