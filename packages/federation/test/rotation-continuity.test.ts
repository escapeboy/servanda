import { afterAll, describe, expect, it } from 'vitest';
import { edgeId, signObject, withSignature } from '@servanda/crypto';
import { verifyAssertionChain } from '@servanda/node';
import { keyLineage } from '@servanda/identity';
import type { Assertion, Edge } from '@servanda/types';
import { PROTOCOL_VERSION } from '@servanda/types';
import { signMessage } from '../src/messages.js';
import { makeSolo, persona } from './support/fixture.js';

/**
 * §1.7: *"The signature by `old` is what transfers continuity: verifiers MUST treat `new` as the
 * successor for all open edges of `old`."*
 *
 * That MUST was prose. `resolveSuccessor` existed, was correct, and had **no production caller**;
 * `Vault` had no rotation record type, so a counterparty holding a perfectly valid statement had
 * nowhere to put it. A rotated key was refused `signer-not-a-party` on its own edge, and over the
 * wire the counterparty discarded it `sender-is-not-a-party`.
 *
 * What that cost: §1.7 lists rotation as one of two seedless recovery paths and ADR-0014 argues a
 * persona survives the loss of a device. It did not. A story that rotated a key continued only
 * because the persona still held the seed — because the rotation was unnecessary. **The recovery
 * path for the case where you have lost everything worked only when you had lost nothing.**
 *
 * The gates below are what keep this from being the takeover §1.7 exists to prevent. A rotation is
 * a PUBLISHED artefact, and §6.6 already learned that a signature which verifies is not proof that
 * the person it names is the one talking to you.
 */

/** ME holds the vault. THEM is the counterparty who rotates. NEXT is their new key. */
const ME = persona(0);
const THEM = persona(1);
const NEXT = persona(2);
const STRANGER = persona(3);

const AT = '2026-07-25T12:00:00.000Z';

const solo = makeSolo(0);
afterAll(() => solo.cleanup());

const body = {
  commitment_hash: 'a'.repeat(64),
  owner: THEM.personaId,
  owed_to: ME.personaId,
  proposed_at: '2026-07-25T09:00:00Z',
};
const EDGE: Edge = {
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

function assertion(
  state: 'proposed' | 'confirmed' | 'released' | 'closed',
  by: typeof ME,
  at: string,
  evidence: string | null = null,
): Assertion {
  return withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id: EDGE.edge_id,
      state,
      asserted_at: at,
      by: by.personaId,
      evidence_hash: evidence,
    },
    by.privateKey,
  ) as Assertion;
}

solo.vault.putEdge(ME.personaId, EDGE);
solo.vault.appendAssertion(ME.personaId, assertion('proposed', THEM, '2026-07-25T09:00:00Z'));
solo.vault.appendAssertion(ME.personaId, assertion('confirmed', ME, '2026-07-25T10:00:00Z'));

function rotation(from: typeof ME, to: typeof ME) {
  const core = {
    v: PROTOCOL_VERSION,
    type: 'rotation' as const,
    old: from.personaId,
    new: to.personaId,
    rotated_at: AT,
  };
  return { ...core, sig: signObject(core, from.privateKey) };
}

const deliver = (payload: unknown, from: typeof ME) =>
  solo.inbox.ingest([signMessage('rotation', payload, from.personaId, ME.personaId, AT, from.privateKey)]);

/**
 * What this vault now believes about the keys each party has held — the SAME function the node
 * uses, not a second walk of the same rotations. A test that reimplemented this would agree with
 * itself and prove nothing about what a node computes.
 */
const lineage = () => {
  const rotations = solo.vault.listRotations(ME.personaId);
  return (key: string) => keyLineage(key, rotations);
};

const stateWith = (chain: Assertion[]) =>
  verifyAssertionChain(EDGE, chain, undefined, lineage());

describe('§1.7 continuity does not transfer to anyone who merely holds the statement', () => {
  it('a statement signed only by the NEW key is refused — that is the takeover', () => {
    const core = { v: PROTOCOL_VERSION, type: 'rotation' as const, old: THEM.personaId, new: NEXT.personaId, rotated_at: AT };
    const forged = { ...core, sig: signObject(core, NEXT.privateKey) };
    expect(deliver(forged, NEXT).discarded).toContainEqual({
      type: 'rotation',
      edge_id: null,
      reason: 'rotation-does-not-verify',
    });
  });

  it('an observer holding a valid copy cannot deliver it', () => {
    // The §6.6 lesson applied before it had to be learned twice: a rotation is published, so a
    // valid signature proves the statement is real and proves nothing about who is speaking.
    expect(deliver(rotation(THEM, NEXT), STRANGER).discarded).toContainEqual({
      type: 'rotation',
      edge_id: null,
      reason: 'rotation-from-a-third-party',
    });
  });

  it('a rotation about somebody we have no edge with is not stored', () => {
    // Otherwise any persona that can reach us fills the vault with rotations about strangers — an
    // unbounded store keyed by attacker-chosen values, in a place §6.5's budget does not look.
    expect(deliver(rotation(STRANGER, NEXT), STRANGER).discarded).toContainEqual({
      type: 'rotation',
      edge_id: null,
      reason: 'rotation-for-an-unknown-party',
    });
  });

  it('and none of the three was stored', () => {
    expect(solo.vault.listRotations(ME.personaId)).toEqual([]);
  });
});

describe('§1.7 continuity DOES transfer when the counterparty announces it', () => {
  it('the statement is accepted from the key it rotates from', () => {
    expect(deliver(rotation(THEM, NEXT), THEM).accepted).toContainEqual({
      type: 'rotation',
      edge_id: null,
    });
    expect(solo.vault.listRotations(ME.personaId)).toHaveLength(1);
  });

  it('the successor may now act on the predecessor’s open edge, in the predecessor’s ROLE', () => {
    // The MUST, executable at last. NEXT succeeds THEM, who owns this edge, so NEXT gets the
    // OWNER's transition — `closed` with evidence. A successor inherits the role, not a new one.
    const chain = [
      ...solo.vault.getAssertions(ME.personaId, EDGE.edge_id),
      assertion('closed', NEXT, '2026-07-26T09:00:00Z', 'e'.repeat(64)),
    ];
    const verified = stateWith(chain);
    expect(verified.outcomes.at(-1)!.accepted, JSON.stringify(verified.outcomes.at(-1))).toBe(true);
    expect(verified.final_state).toBe('closed');
  });

  it('and not the counterparty’s role — inheriting a key is not inheriting a side', () => {
    const chain = [
      ...solo.vault.getAssertions(ME.personaId, EDGE.edge_id),
      assertion('released', NEXT, '2026-07-26T09:00:00Z'),
    ];
    expect(stateWith(chain).outcomes.at(-1)!.rejection_reason).toBe('wrong-signer-for-transition');
  });

  it('the predecessor’s OWN earlier assertions stay valid — a rotation is not amnesia', () => {
    // §1.3's rule, restated: "edges signed before `revoked_at` remain valid". The `proposed` that
    // opened this edge was signed by THEM before the rotation, and resolving the party to its
    // newest key alone invalidated it — which broke the whole chain, not just the last assertion.
    const verified = stateWith(solo.vault.getAssertions(ME.personaId, EDGE.edge_id));
    expect(verified.outcomes.every((o) => o.accepted)).toBe(true);
    expect(verified.final_state).toBe('open');
  });

  it('and the predecessor no longer can — a rotation moves the key, it does not add one', () => {
    // Otherwise a stolen old key keeps working for ever beside its replacement, which is the
    // opposite of what rotating is for.
    const chain = [
      ...solo.vault.getAssertions(ME.personaId, EDGE.edge_id),
      assertion('closed', THEM, '2026-07-26T09:00:00Z', 'e'.repeat(64)),
    ];
    expect(stateWith(chain).outcomes.at(-1)!.rejection_reason).toBe('signer-not-a-party');
  });

  it('the edge object is untouched — §4.1 binds it, and a rotation is not an edit', () => {
    const held = solo.vault.getEdge(ME.personaId, EDGE.edge_id)!;
    expect(held.owner).toBe(THEM.personaId);
    expect(held.edge_id).toBe(EDGE.edge_id);
  });

  it('a fork stops continuity rather than picking a winner', () => {
    // Two rotations from one key. §1.7: "a verifier MUST NOT choose between them: continuity stops
    // at the fork and the identity MUST be reported as unresolved." So the successor stops working
    // too — both keys become strangers to the edge until somebody resolves it, which is the safe
    // direction to fail in.
    deliver(rotation(THEM, STRANGER), THEM);
    expect(solo.vault.listRotations(ME.personaId)).toHaveLength(2);

    const chain = [
      ...solo.vault.getAssertions(ME.personaId, EDGE.edge_id),
      assertion('closed', NEXT, '2026-07-26T09:00:00Z', 'e'.repeat(64)),
    ];
    expect(stateWith(chain).outcomes.at(-1)!.rejection_reason).toBe('signer-not-a-party');
  });
});
