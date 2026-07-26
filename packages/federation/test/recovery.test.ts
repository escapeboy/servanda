import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectiveState } from '@servanda/node';
import { applyRecoverResponse } from '../src/inbox.js';
import { RecoveryResponder, signChallenge, signRotation } from '../src/recovery.js';
import { makePair, makeSolo, persona, type Pair } from './support/fixture.js';

/**
 * §6.6 edge recovery (ADR-0014). "Responders MUST verify the persona (or its rotation
 * successor) before answering."
 */

const SUCCESSOR = persona(8);

let pair: Pair;
let edgeId: string;
let responder: RecoveryResponder;

beforeAll(async () => {
  pair = makePair();
  edgeId = pair.a.node.commit({
    intent: 'restore my edges after losing the laptop',
    owed_to: pair.b.personaId,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  await pair.a.fed.push();
  await pair.b.fed.pull();
  pair.b.node.confirm({ id: edgeId, decision: 'confirm' });
  responder = new RecoveryResponder({ vault: pair.b.vault, persona: pair.b.personaId });
});
afterAll(() => pair.cleanup());

describe('§6.6 edge recovery', () => {
  it('a fresh signature challenge from a party recovers its edges and chains', () => {
    const { verdict, response } = responder.answer({
      persona: pair.a.personaId,
      proof: signChallenge(responder.issueChallenge(), pair.a.privateKey),
    });
    expect(verdict).toEqual({ verified: true, persona: pair.a.personaId, predecessor: null });
    expect(response.edges).toHaveLength(1);
    expect(response.edges[0]!.assertions).toHaveLength(2);
  });

  it('a challenge the responder did not issue is refused (freshness is the responder’s to set)', () => {
    const { verdict } = responder.answer({
      persona: pair.a.personaId,
      proof: signChallenge('replayed-forever', pair.a.privateKey),
    });
    expect(verdict).toMatchObject({ verified: false });
  });

  it('a challenge is spent once used', () => {
    const challenge = responder.issueChallenge();
    const proof = signChallenge(challenge, pair.a.privateKey);
    expect(responder.answer({ persona: pair.a.personaId, proof }).verdict.verified).toBe(true);
    expect(responder.answer({ persona: pair.a.personaId, proof }).verdict.verified).toBe(false);
  });

  it('§1.7: a rotation successor recovers the predecessor’s edges', () => {
    const rotation = signRotation(
      pair.a.personaId,
      SUCCESSOR.personaId,
      '2026-07-26T09:00:00Z',
      pair.a.privateKey,
    );
    const { verdict, response } = responder.answer({ persona: SUCCESSOR.personaId, proof: rotation });
    expect(verdict).toEqual({
      verified: true,
      persona: SUCCESSOR.personaId,
      predecessor: pair.a.personaId,
    });
    expect(response.edges.map((e) => e.edge.edge_id)).toEqual([edgeId]);
  });

  it('a rotation signed by the NEW key proves nothing (§1.7: the old key transfers continuity)', () => {
    const forged = signRotation(
      pair.a.personaId,
      SUCCESSOR.personaId,
      '2026-07-26T09:00:00Z',
      SUCCESSOR.privateKey,
    );
    expect(responder.answer({ persona: SUCCESSOR.personaId, proof: forged }).verdict).toMatchObject({
      verified: false,
    });
  });

  it('a rotation from a key this responder has never dealt with is refused', () => {
    const stranger = persona(9);
    const rotation = signRotation(
      stranger.personaId,
      SUCCESSOR.personaId,
      '2026-07-26T09:00:00Z',
      stranger.privateKey,
    );
    expect(responder.answer({ persona: SUCCESSOR.personaId, proof: rotation }).verdict).toMatchObject({
      verified: false,
    });
  });

  it('a recovered chain is replayed through the transition table before it is stored', () => {
    const solo = makeSolo(0);
    try {
      const { response } = responder.answer({
        persona: pair.a.personaId,
        proof: signChallenge(responder.issueChallenge(), pair.a.privateKey),
      });
      const applied = applyRecoverResponse(solo.vault, solo.personaId, response);
      expect(applied.restored).toEqual([edgeId]);
      expect(applied.discarded).toEqual([]);
      expect(
        effectiveState(solo.vault.getEdge(solo.personaId, edgeId)!, solo.vault.getAssertions(solo.personaId, edgeId)),
      ).toBe('open');
      // …and the restored node still has no plaintext: "remember that, not what".
      const edge = solo.vault.getEdge(solo.personaId, edgeId)!;
      expect(solo.vault.getCommitment(solo.personaId, edge.commitment_hash)).toBeNull();
    } finally {
      solo.cleanup();
    }
  });
});
