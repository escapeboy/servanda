import { afterAll, describe, expect, it } from 'vitest';
import { edgeId, signObject, withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Edge } from '@servanda/types';
import { RecoveryResponder } from '../src/recovery.js';
import { makeSolo, persona } from './support/fixture.js';

/**
 * §6.6: a responder "SHOULD refuse a `challenge` it has already answered."
 *
 * The plain-challenge branch spent it. The rotation branch returned one line earlier and did not,
 * so a single rotation proof could be replayed indefinitely — and a recovery answer is the
 * requester's WHOLE edge set. That makes a replayable proof the same bulk disclosure §6.6's
 * proof-of-possession rule was added to stop, reached through the branch nobody re-read.
 *
 * Two nearly identical paths, one guard: the shape this repository keeps producing.
 */

const ME = persona(0);
const NEXT = persona(2);

const solo = makeSolo(0);
afterAll(() => solo.cleanup());

const responder = () => new RecoveryResponder({ vault: solo.vault, persona: ME.personaId });

/**
 * The rotation branch refuses a request whose `old` key is party to nothing, so the vault needs
 * one edge for that path to be reachable at all. Standing it up here rather than skipping the
 * case: the branch that was not spending its challenge is precisely the one worth exercising.
 */
const OTHER = persona(1);
const edgeBody = {
  commitment_hash: 'a'.repeat(64),
  owner: ME.personaId,
  owed_to: OTHER.personaId,
  proposed_at: '2026-07-25T09:00:00Z',
};
const EDGE: Edge = {
  v: PROTOCOL_VERSION,
  type: 'edge',
  edge_id: edgeId(edgeBody),
  ...edgeBody,
  due: null,
  closure_policy: 'on-evidence',
  acceptance_window: null,
  blocked_by: [],
  supersedes: null,
};
solo.vault.putEdge(ME.personaId, EDGE);
solo.vault.appendAssertion(
  ME.personaId,
  withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id: EDGE.edge_id,
      state: 'proposed' as const,
      asserted_at: edgeBody.proposed_at,
      by: ME.personaId,
      evidence_hash: null,
    },
    ME.privateKey,
  ),
);

const sign = (challenge: string, by: { privateKey: string }) =>
  signObject({ challenge }, by.privateKey);

describe('§6.6 a challenge is answered once, on both branches', () => {
  it('the plain-challenge form is spent', () => {
    const r = responder();
    const challenge = r.issueChallenge();
    const request = { v: 'servanda/0.2' as const, type: 'recover_request' as const, persona: ME.personaId, proof: { challenge, sig: sign(challenge, ME) } };

    expect(r.verifyRequest(request).verified).toBe(true);
    expect(r.verifyRequest(request).verified).toBe(false);
  });

  it('and so is the rotation form', () => {
    // The branch that did not spend it. A valid rotation plus one signature over the challenge
    // used to answer for ever.
    const r = responder();
    const challenge = r.issueChallenge();
    const rotation = {
      v: 'servanda/0.2' as const,
      type: 'rotation' as const,
      old: ME.personaId,
      new: NEXT.personaId,
      rotated_at: '2026-07-25T09:00:00Z',
    };
    const request = {
      v: 'servanda/0.2' as const,
      type: 'recover_request' as const,
      persona: NEXT.personaId,
      proof: {
        challenge,
        sig: sign(challenge, NEXT),
        rotation: { ...rotation, sig: signObject(rotation, ME.privateKey) },
      },
    };

    const first = r.verifyRequest(request);
    expect(first.verified, JSON.stringify(first)).toBe(true);
    expect(r.verifyRequest(request).verified).toBe(false);
  });

  it('a fresh challenge still works after one is spent', () => {
    // The control: spending must not disable the responder, only that nonce.
    const r = responder();
    const spent = r.issueChallenge();
    r.verifyRequest({ v: 'servanda/0.2' as const, type: 'recover_request' as const, persona: ME.personaId, proof: { challenge: spent, sig: sign(spent, ME) } });

    const fresh = r.issueChallenge();
    expect(
      r.verifyRequest({ v: 'servanda/0.2' as const, type: 'recover_request' as const, persona: ME.personaId, proof: { challenge: fresh, sig: sign(fresh, ME) } }).verified,
    ).toBe(true);
  });
});
