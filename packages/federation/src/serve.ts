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
 * May `holder` serve `edge` to `requester`?
 *
 * Scope membership is read as: the requester IS the scope key, or the holder holds a valid
 * (unexpired, unrevoked) attestation naming the scope key as issuer and the requester as
 * subject. M-4c is satisfied structurally — a scope is matched by exact key, so no org key ever
 * stands in for a team key or vice versa.
 */
export function mayServeEdge(vault: Vault, holder: string, requester: string, edge: Edge): ServeGrant {
  if (isParty(edge, requester)) return { serve: true, via: 'party' };

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
