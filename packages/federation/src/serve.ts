import { keyLineage } from '@servanda/identity';
import type { KeyLineage } from '@servanda/node';
import type { Edge } from '@servanda/types';
import type { Vault } from '@servanda/vault';

/**
 * §5.3 / M-4 on the wire.
 *
 * M-4a: "A node MUST NOT serve an edge to any persona that is neither a party nor a member of a
 * scope the edge is published in."
 * M-4b: "Scope membership grants NO visibility by itself into unpublished edges of members."
 * M-4c: "No inheritance."
 *
 * This is the single choke point for everything this layer serves on request — recon responses
 * and recovery responses both go through it. It is deliberately a positive test: the default
 * answer is "no", and every "yes" has to name the rule that produced it.
 */

export type ServeGrant =
  | { serve: false; reason: 'not-a-party-and-not-published-to-a-scope-you-belong-to' }
  | { serve: true; via: 'party' }
  | { serve: true; via: 'scope'; scope: string };

export function isParty(edge: Edge, persona: string): boolean {
  return edge.owner === persona || edge.owed_to === persona;
}

/**
 * §1.7 continuity, as this layer needs it: the keys each party has held, from the rotation
 * statements THIS vault has accepted.
 *
 * The same shape `ServandaNode` builds for its own reads, built here because the federation layer
 * had none and that was the whole defect. `verifyAssertionChain` honours a rotation — the §4.3
 * table resolves a signer through the lineage — but every call site in this package passed no
 * lineage at all, and every party gate compared keys literally. So a counterparty who took §1.7's
 * seedless recovery path could not be heard: their `assert` was discarded `sender-is-not-a-party`
 * at the door, their reconciliation was ignored, and the edges a responder correctly handed back
 * were dropped by the applier. §1.7's "verifiers MUST treat `new` as the successor for all open
 * edges of `old`" held in the table and nowhere on the wire.
 *
 * Rebuilt per call rather than cached, for the reason the node gives: a rotation arriving over the
 * wire has to take effect on the next read, and a stale map is how a rotated-away key keeps working.
 */
export function partyLineage(vault: Vault, persona: string): KeyLineage {
  const rotations = vault.listRotations(persona);
  if (rotations.length === 0) return (key) => [{ key, supersededAt: null }];
  return (key) => keyLineage(key, rotations);
}

/**
 * Is `key` a party to this edge, or the verified successor of one?
 *
 * ADMISSION only. Whether the key was still current when it signed is a question about an
 * assertion's `asserted_at`, and the §4.3 table already answers it from the same lineage — a
 * superseded key's later assertion is refused there. Deciding it twice, in a gate that sees no
 * assertion, is how the two answers drift apart.
 *
 * A fork stops continuity: `keyLineage` returns the key unchanged when two rotations claim the
 * same predecessor, so ambiguous successors stay strangers. That is §1.7's own instruction and it
 * is the safe direction to fail in.
 */
export function isPartyOrSuccessor(edge: Edge, key: string, lineage: KeyLineage): boolean {
  if (isParty(edge, key)) return true;
  return (
    lineage(edge.owner).some((k) => k.key === key) || lineage(edge.owed_to).some((k) => k.key === key)
  );
}

/**
 * The key a party holds NOW — the address to send to.
 *
 * The lineage is oldest-first and only its last entry is open, so the last entry is the current
 * key. At a fork the lineage is the single key it started from, which is what §1.7 wants: an
 * unresolved identity is addressed at the key we can still name, not at one of two guesses.
 */
export function currentKeyOf(key: string, lineage: KeyLineage): string {
  return lineage(key).at(-1)?.key ?? key;
}

/**
 * May `holder` serve `edge` to `requester`?
 *
 * Scope membership is read as: the requester IS the scope key, or the holder holds a valid
 * (unexpired, unrevoked) attestation naming the scope key as issuer and the requester as
 * subject. M-4c is satisfied structurally — a scope is matched by exact key, so no org key ever
 * stands in for a team key or vice versa.
 */
export function mayServeEdge(vault: Vault, holder: string, requester: string, edge: Edge): ServeGrant {
  // §1.7: a party who rotated is still that party. The rotation is only believed because THIS
  // vault accepted it, and `Inbox.ingestRotation` accepts one only from a key that signs it and
  // only about somebody we already share an edge with — so this widens disclosure to the
  // successor of a persona we were already serving, and to nobody else.
  if (isPartyOrSuccessor(edge, requester, partyLineage(vault, holder))) return { serve: true, via: 'party' };

  for (const record of vault.listPublishRecords(holder)) {
    if (record.edge_id !== edge.edge_id) continue;
    // §5.2: only a party may publish. A publish record signed by a non-party is not a grant;
    // the vault refuses to store one, and this re-check keeps the rule local to the decision.
    if (!isParty(edge, record.by)) continue;
    if (record.scope === requester) return { serve: true, via: 'scope', scope: record.scope };
    const attestation = vault.getAttestation(holder, requester);
    if (!attestation || attestation.org !== record.scope) continue;
    const revocation = vault.getRevocation(holder, requester);
    const now = Date.parse(vault.now());
    if (revocation && Date.parse(revocation.revoked_at) <= now) continue;
    if (Date.parse(attestation.expires_at) < now) continue;
    return { serve: true, via: 'scope', scope: record.scope };
  }

  return { serve: false, reason: 'not-a-party-and-not-published-to-a-scope-you-belong-to' };
}
