import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectiveState } from '@servanda/node';
import { applyRecoverResponse } from '../src/inbox.js';
import { applyReconResponse } from '../src/recon.js';
import { RecoveryResponder, signChallenge } from '../src/recovery.js';
import { makePair, makeSolo, persona, type Pair } from './support/fixture.js';

/**
 * The two appliers that take a whole chain from somebody else — §6.4's `recon_response` and
 * §6.6's `recover_response`. Both replay through the transition table, which is what stops a
 * fabricated state. Neither of these cases is about fabrication: every assertion below is
 * genuine and signed by a real party. They are about the two decisions the RESPONDER was still
 * making on our behalf — what order we evaluate in, and whether it was entitled to hand us the
 * chain at all.
 */

let pair: Pair;
let edgeId: string;
let responder: RecoveryResponder;

beforeAll(async () => {
  pair = makePair();
  edgeId = pair.a.node.commit({
    intent: 'a promise worth recovering',
    owed_to: pair.b.personaId,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  await pair.a.fed.push();
  await pair.b.fed.pull();
  // The confirmation is made a minute later, so the chain carries the only causal signal §4.2
  // gives it: two distinct `asserted_at` values. The same-instant case is pinned separately.
  pair.setNow(new Date('2026-07-25T09:01:00.000Z'));
  pair.b.node.confirm({ id: edgeId, decision: 'confirm' });
  responder = new RecoveryResponder({ vault: pair.b.vault, persona: pair.b.personaId });
});
afterAll(() => pair.cleanup());

/** The honest §6.6 answer to a valid challenge: the edge and its `[proposed, accepted]` chain. */
function honestResponse() {
  return responder.answer({
    persona: pair.a.personaId,
    proof: signChallenge(responder.issueChallenge(), pair.a.privateKey),
  }).response;
}

describe('§6.6: a responder does not get to choose the state we recover into', () => {
  it('a reversed chain restores the same edge state as the honest order', () => {
    const solo = makeSolo(0);
    try {
      const response = honestResponse();
      // The only hostile act: hand back the same two genuine assertions back-to-front. Replayed
      // in that order `confirmed` has no legal source state, so it was dropped and the edge
      // settled at `proposed` — the counterparty's confirmation erased by an array order, with
      // §6.4's applier already defending against exactly this and §6.6's not.
      const reversed = {
        edges: response.edges.map((e) => ({ edge: e.edge, assertions: [...e.assertions].reverse() })),
      };
      const applied = applyRecoverResponse(solo.vault, solo.personaId, reversed);

      expect(applied.discarded).toEqual([]);
      expect(
        effectiveState(
          solo.vault.getEdge(solo.personaId, edgeId)!,
          solo.vault.getAssertions(solo.personaId, edgeId),
        ),
      ).toBe('open');
    } finally {
      solo.cleanup();
    }
  });
});

describe('assertions made in the same instant keep the order they were sent in', () => {
  it('an honest same-second chain converges in one exchange, whatever its signatures sort to', async () => {
    // §4.2 assertions have no `prev`, so a propose and a confirmation inside one clock tick carry
    // identical `asserted_at`. Ordering those by `sig` — the tie-break this used to apply — sorts
    // them by signature bytes, which is causally meaningless and drops `confirmed` from an honest
    // chain whenever the hashes fall the wrong way. This edge is the case that fell that way.
    const tied = makePair();
    try {
      const id = tied.a.node.commit({
        intent: 'restore my edges after losing the laptop',
        owed_to: tied.b.personaId,
        due: null,
        persona: null,
        propose: true,
      }).edge_id!;
      await tied.a.fed.push();
      await tied.b.fed.pull();
      tied.b.node.confirm({ id, decision: 'confirm' });

      const chain = tied.b.vault.getAssertions(tied.b.personaId, id);
      expect(new Set(chain.map((a) => a.asserted_at)).size).toBe(1);
      expect(chain[0]!.sig > chain[1]!.sig).toBe(true); // …so a `sig` tie-break would invert it

      const solo = makeSolo(0);
      try {
        solo.vault.putEdge(solo.personaId, tied.b.vault.getEdge(tied.b.personaId, id)!);
        const applied = applyReconResponse(solo.vault, solo.personaId, tied.b.personaId, {
          edges: [{ edge_id: id, assertions: chain }],
        });
        expect(applied.discarded).toEqual([]);
        expect(applied.accepted).toHaveLength(2);
      } finally {
        solo.cleanup();
      }
    } finally {
      tied.cleanup();
    }
  });
});

describe('§6.6: a responder cannot plant an edge we were never in', () => {
  it('an edge naming two other personas is not stored, chain and all', () => {
    const solo = makeSolo(2); // persona 2 is neither party to the edge below
    try {
      const { edge, assertions } = honestResponse().edges[0]!;
      const applied = applyRecoverResponse(solo.vault, solo.personaId, { edges: [{ edge, assertions }] });

      // §6.6 restores "all edges where the REQUESTER is a party". A responder answering with
      // somebody else's edge is handing us a promise we have no part in — and unlike §6.4's
      // applier, this one does create edges, so an unchecked entry would be written outright.
      expect(applied.restored).toEqual([]);
      expect(solo.vault.getEdge(solo.personaId, edgeId)).toBeNull();
      expect(solo.vault.listEdgeIds(solo.personaId)).toEqual([]);
    } finally {
      solo.cleanup();
    }
  });
});

describe('§6.4: reconciliation is pairwise, so both ends must be parties', () => {
  it('a chain offered by a persona with no part in the edge is ignored', () => {
    const stranger = persona(9).personaId;
    const solo = makeSolo(0);
    try {
      const { edge, assertions } = honestResponse().edges[0]!;
      solo.vault.putEdge(solo.personaId, edge);

      const applied = applyReconResponse(solo.vault, solo.personaId, stranger, {
        edges: [{ edge_id: edgeId, assertions }],
      });

      expect(applied.accepted).toEqual([]);
      expect(applied.ignored).toEqual([edgeId]);
      expect(solo.vault.getAssertions(solo.personaId, edgeId)).toEqual([]);
    } finally {
      solo.cleanup();
    }
  });

  it('…and the counterparty offering the same chain is applied', () => {
    const solo = makeSolo(0);
    try {
      const { edge, assertions } = honestResponse().edges[0]!;
      solo.vault.putEdge(solo.personaId, edge);

      const applied = applyReconResponse(solo.vault, solo.personaId, pair.b.personaId, {
        edges: [{ edge_id: edgeId, assertions }],
      });

      expect(applied.ignored).toEqual([]);
      expect(applied.accepted).toHaveLength(2);
    } finally {
      solo.cleanup();
    }
  });
});
