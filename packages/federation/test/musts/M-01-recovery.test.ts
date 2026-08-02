import { afterAll, describe, expect, it } from 'vitest';
import { edgeId, withSignature } from '@servanda/crypto';
import type { Assertion, Edge } from '@servanda/types';
import { PROTOCOL_VERSION } from '@servanda/types';
import { applyRecoverResponse } from '../../src/inbox.js';
import { makeSolo, persona } from '../support/fixture.js';

/**
 * M-1 on the §6.6 recovery path: *"A promise is owned by its giver: no wire object may create a
 * commitment whose owner is not the signing persona."*
 *
 * §4.2 puts every signature on the ASSERTIONS. The edge object carries none — `edge_id` is a
 * digest its minter computes, which §4.1's binding rule checks and which says nothing about who
 * agreed to it. So an edge restored before its chain is judged is a promise accepted on nothing
 * but the responder's word.
 *
 * A recovery responder returned two fabricated edges with empty chains and both were stored, one
 * naming the requester as **owner** — a promise the victim never made, in the victim's own vault.
 * It bypassed the propose path, M-14 and the §6.5 anti-spam budget in one move, and the victim is
 * a node that just lost its vault, so it holds nothing to compare against.
 *
 * The rule: an edge is restored only when the chain it arrives with yields an ACCEPTED `proposed`
 * signed by that edge's own owner. The same question `propose` asks of one message, asked of a
 * whole chain.
 */

const ME = persona(0);
const THEM = persona(1);
const AT = '2026-07-25T09:00:00.000Z';

const solo = makeSolo(0);
afterAll(() => solo.cleanup());

function edgeOwnedBy(owner: string, owedTo: string, proposedAt = AT): Edge {
  const body = { commitment_hash: 'a'.repeat(64), owner, owed_to: owedTo, proposed_at: proposedAt };
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

function proposedBy(edge: Edge, by: { personaId: string; privateKey: string }): Assertion {
  return withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id: edge.edge_id,
      state: 'proposed' as const,
      asserted_at: edge.proposed_at,
      by: by.personaId,
      evidence_hash: null,
    },
    by.privateKey,
  ) as Assertion;
}

const apply = (edges: { edge: Edge; assertions: Assertion[] }[]) =>
  applyRecoverResponse(solo.vault, ME.personaId, { persona: ME.personaId, edges });

describe('§6.6: recovery restores promises, not assertions about them', () => {
  it('an edge with no chain at all is not restored', () => {
    const fabricated = edgeOwnedBy(THEM.personaId, ME.personaId, '2026-07-25T09:00:01Z');
    const { restored, discarded } = apply([{ edge: fabricated, assertions: [] }]);

    expect(restored).toEqual([]);
    expect(discarded).toContainEqual({
      edge_id: fabricated.edge_id,
      index: -1,
      reason: 'no-accepted-proposal-by-the-owner',
    });
    expect(solo.vault.getEdge(ME.personaId, fabricated.edge_id)).toBeNull();
  });

  it('nor one naming the RECIPIENT as owner — a promise they never made', () => {
    // The worst shape: after recovery the victim's own node reports them as owing something.
    const planted = edgeOwnedBy(ME.personaId, THEM.personaId, '2026-07-25T09:00:02Z');
    const { restored } = apply([{ edge: planted, assertions: [] }]);

    expect(restored).toEqual([]);
    expect(solo.vault.getEdge(ME.personaId, planted.edge_id)).toBeNull();
  });

  it('nor one whose only assertion is signed by the wrong party', () => {
    // The counterparty cannot propose the owner's promise (M-1), so this chain yields no
    // accepted `proposed` and the edge has nothing standing behind it.
    const edge = edgeOwnedBy(THEM.personaId, ME.personaId, '2026-07-25T09:00:03Z');
    const { restored, discarded } = apply([{ edge, assertions: [proposedBy(edge, ME)] }]);

    expect(restored).toEqual([]);
    expect(discarded.some((d) => d.edge_id === edge.edge_id)).toBe(true);
  });

  it('a genuine edge IS restored — the check must not have broken recovery', () => {
    // The control. §6.6 exists so a node that lost its vault can get its edges back, and a fix
    // that stopped that would be worse than the hole it closed.
    const edge = edgeOwnedBy(THEM.personaId, ME.personaId, '2026-07-25T09:00:04Z');
    const { restored, discarded } = apply([{ edge, assertions: [proposedBy(edge, THEM)] }]);

    expect(restored).toEqual([edge.edge_id]);
    expect(discarded).toEqual([]);
    expect(solo.vault.getEdge(ME.personaId, edge.edge_id)!.owner).toBe(THEM.personaId);
  });

  it('and one bad edge in a batch does not take the good one with it', () => {
    const good = edgeOwnedBy(THEM.personaId, ME.personaId, '2026-07-25T09:00:05Z');
    const bad = edgeOwnedBy(THEM.personaId, ME.personaId, '2026-07-25T09:00:06Z');
    const { restored } = apply([
      { edge: bad, assertions: [] },
      { edge: good, assertions: [proposedBy(good, THEM)] },
    ]);

    expect(restored).toEqual([good.edge_id]);
  });
});
