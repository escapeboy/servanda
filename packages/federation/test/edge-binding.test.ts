import { afterAll, describe, expect, it } from 'vitest';
import { edgeId, withSignature } from '@servanda/crypto';
import type { Edge } from '@servanda/types';
import { PROTOCOL_VERSION } from '@servanda/types';
import { signMessage } from '../src/messages.js';
import { applyRecoverResponse } from '../src/inbox.js';
import { makeSolo, persona } from './support/fixture.js';

/**
 * §4.1: "A node MUST bind an `edge_id` to the first edge body it accepts for that identifier,
 * and MUST reject any subsequent edge body bearing the same `edge_id` whose other members
 * differ, with the whole body discarded rather than merged."
 *
 * Nothing implemented it. `edgeId()` had no production caller outside creation, so an `edge_id`
 * arriving over the wire was a name the sender chose rather than a digest of what the sender
 * sent — and an `edge_id` is what an assertion chain is filed under.
 *
 * The consequence is not a wrong state; the transition table still refuses a non-party's
 * assertion when the chain is next read. It is that the chain PERMANENTLY holds an assertion
 * the counterparty does not have, so `latestAssertionHash` never again matches theirs, and
 * §6.4 — whose entire guarantee is "both sides see the same chain" — can never converge on
 * that edge. One signed message, by a stranger, and the edge is stuck for good.
 */

const ME = persona(0);
const BOB = persona(1);
const MALLORY = persona(2);

const solo = makeSolo(0);
afterAll(() => solo.cleanup());

const AT = '2026-07-25T09:00:00.000Z';

function edgeBetween(owner: string, owedTo: string, proposedAt = AT): Edge {
  const commitment_hash = 'a'.repeat(64);
  const body = { commitment_hash, owner, owed_to: owedTo, proposed_at: proposedAt };
  return {
    v: PROTOCOL_VERSION,
    type: 'edge',
    edge_id: edgeId(body),
    ...body,
    due: null,
    closure_policy: 'on-evidence',
    acceptance_window: null,
    blocked_by: [],
    supersedes: null,
  };
}

function proposedBy(edge: Edge, by: { personaId: string; privateKey: string }) {
  return withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id: edge.edge_id,
      state: 'proposed' as const,
      asserted_at: AT,
      by: by.personaId,
      evidence_hash: null,
    },
    by.privateKey,
  );
}

function propose(edge: Edge, from: { personaId: string; privateKey: string }) {
  return signMessage(
    'propose',
    { edge, assertion: proposedBy(edge, from) },
    from.personaId,
    ME.personaId,
    AT,
    from.privateKey,
  );
}

describe('§4.1 an edge_id is bound to the body it digests', () => {
  it('a propose whose edge_id is not the digest of its own body is discarded', () => {
    const honest = edgeBetween(BOB.personaId, ME.personaId);
    const lying: Edge = { ...honest, edge_id: 'b'.repeat(64) };
    const result = solo.inbox.ingest([propose(lying, BOB)]);

    expect(result.accepted).toHaveLength(0);
    expect(result.discarded).toContainEqual({
      type: 'propose',
      edge_id: lying.edge_id,
      reason: 'edge-id-does-not-bind-body',
    });
    expect(solo.vault.getEdge(ME.personaId, lying.edge_id)).toBeNull();
  });

  it('a stranger cannot graft an assertion into an edge chain by reusing its edge_id', () => {
    const held = edgeBetween(BOB.personaId, ME.personaId, '2026-07-25T09:00:01.000Z');
    solo.vault.putEdge(ME.personaId, held);
    solo.vault.appendAssertion(ME.personaId, proposedBy(held, BOB));
    const before = solo.vault.getAssertions(ME.personaId, held.edge_id);

    // Mallory is a party to nothing. She names herself owner of an edge she owes ME, which
    // satisfies M-1 and M-4a on its own body — and files it under BOB's edge_id.
    const graft: Edge = { ...edgeBetween(MALLORY.personaId, ME.personaId), edge_id: held.edge_id };
    const result = solo.inbox.ingest([propose(graft, MALLORY)]);

    expect(result.accepted).toHaveLength(0);
    expect(solo.vault.getAssertions(ME.personaId, held.edge_id)).toEqual(before);
    // And the body BOB and ME agreed on is still the body this node holds.
    expect(solo.vault.getEdge(ME.personaId, held.edge_id)!.owner).toBe(BOB.personaId);
  });

  it('a second body under a held edge_id is discarded whole, never merged', () => {
    const held = edgeBetween(BOB.personaId, ME.personaId, '2026-07-25T09:00:02.000Z');
    solo.vault.putEdge(ME.personaId, held);

    // Same four bound members, so the edge_id is genuinely its digest. `closure_policy` is not
    // covered by the preimage and decides who may close (§4.4) — which is exactly why §4.1
    // makes first-sight binding a MUST rather than leaving the id to speak for the body.
    const swapped: Edge = { ...held, closure_policy: 'on-acceptance', acceptance_window: 'P5D' };
    const result = solo.inbox.ingest([propose(swapped, BOB)]);

    expect(result.discarded).toContainEqual({
      type: 'propose',
      edge_id: held.edge_id,
      reason: 'edge-body-differs-from-held',
    });
    expect(solo.vault.getEdge(ME.personaId, held.edge_id)!.closure_policy).toBe('on-evidence');
  });

  it('§6.6 recovery restores no edge whose id does not bind its body', () => {
    const lying: Edge = { ...edgeBetween(BOB.personaId, ME.personaId), edge_id: 'c'.repeat(64) };
    const { restored } = applyRecoverResponse(solo.vault, ME.personaId, {
      persona: ME.personaId,
      edges: [{ edge: lying, assertions: [] }],
    });

    expect(restored).toEqual([]);
    expect(solo.vault.getEdge(ME.personaId, lying.edge_id)).toBeNull();
  });

  it('the vault refuses an unbound edge whatever route reaches it', () => {
    const lying: Edge = { ...edgeBetween(BOB.personaId, ME.personaId), edge_id: 'd'.repeat(64) };
    expect(() => solo.vault.putEdge(ME.personaId, lying)).toThrow(/edge_id/);
  });
});
