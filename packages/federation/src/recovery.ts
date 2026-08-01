import { z } from 'zod';
import { verifyObject, withSignature } from '@servanda/crypto';
import type { Assertion, Edge, Rotation } from '@servanda/types';
import {
  Assertion as AssertionSchema,
  Edge as EdgeSchema,
  PersonaId,
  PROTOCOL_VERSION,
  Rotation as RotationSchema,
} from '@servanda/types';
import type { Vault } from '@servanda/vault';
import { isParty, mayServeEdge } from './serve.js';

/**
 * §6.6 edge recovery (ADR-0014).
 *
 * - `recover_request`: `{ persona, proof: <rotation statement | fresh signature challenge> }`.
 * - `recover_response`: "all edges + assertion chains where the requester is a party.
 *   Responders MUST verify the persona (or its rotation successor) before answering and MUST
 *   NOT include plaintext (hashes only; plaintext recovery is a human act between
 *   counterparties)."
 *
 * Both MUSTs are enforced structurally rather than by discipline:
 *  - verification first — `answer` calls `verifyRequest` itself and returns an empty response
 *    on failure; there is no code path that serves edges without a verified identity;
 *  - hashes only — the response is built from `Edge` and `Assertion` objects read from the
 *    vault. Neither type has a plaintext field (an edge carries `commitment_hash`, §4.1), and
 *    `getCommitment` is never called in this file. The M-7 test asserts the commitment text
 *    does not appear anywhere in a serialized response.
 */

export type RecoveryProof = Rotation | { challenge: string; sig: string };

/**
 * §6.2 payload shapes. `proof` is only required to BE an object here — deciding what makes a
 * proof acceptable is `verifyRequest`'s job and stays there. What this buys is that a
 * `recover_request` carrying no proof at all is discarded at the inbox instead of reaching a
 * responder that dereferenced it.
 */
export const RecoverRequestSchema = z.object({ persona: PersonaId, proof: z.record(z.unknown()) });
export const RecoverResponseSchema = z.object({
  edges: z.array(z.object({ edge: EdgeSchema, assertions: z.array(AssertionSchema) })),
});

export interface RecoverRequest {
  persona: string;
  proof: RecoveryProof;
}

export type RecoverResponse = z.infer<typeof RecoverResponseSchema>;

export type RecoveryVerdict =
  | { verified: true; persona: string; predecessor: string | null }
  | { verified: false; reason: string };

/** Build the `{challenge, sig}` form: proof of possession of the persona key, right now. */
export function signChallenge(challenge: string, privateKeyHex: string): { challenge: string; sig: string } {
  return withSignature({ challenge }, privateKeyHex);
}

/** Build the rotation form (§1.7): the OLD key signs, and continuity transfers to `new`. */
export function signRotation(oldPub: string, newPub: string, rotatedAt: string, oldPrivateKey: string): Rotation {
  return withSignature(
    { v: PROTOCOL_VERSION, type: 'rotation' as const, old: oldPub, new: newPub, rotated_at: rotatedAt },
    oldPrivateKey,
  ) as Rotation;
}

export interface RecoveryResponderOptions {
  vault: Vault;
  persona: string;
  now?: () => Date;
}

export class RecoveryResponder {
  private readonly vault: Vault;
  private readonly persona: string;
  private readonly clock: () => Date;
  private readonly issued = new Set<string>();
  private counter = 0;

  constructor(opts: RecoveryResponderOptions) {
    this.vault = opts.vault;
    this.persona = opts.persona;
    this.clock = opts.now ?? (() => new Date());
  }

  /**
   * §6.6 says "fresh signature challenge". Freshness only exists if the RESPONDER chose the
   * nonce — a challenge the requester picks proves possession at an unknown time and can be
   * replayed forever, which is the whole failure mode a recovery flow must not have.
   */
  issueChallenge(): string {
    const value = `recover-${++this.counter}-${this.clock().getTime()}`;
    this.issued.add(value);
    return value;
  }

  verifyRequest(request: RecoverRequest): RecoveryVerdict {
    const proof = request.proof as Record<string, unknown>;

    // §6.6 (v0.2, upstream #37): possession is checked FIRST, and a rotation is never a
    // substitute for it.
    //
    // v0.1 took a bare rotation statement as the whole proof. Rotations are PUBLISHED, so the
    // signature a responder verified was genuine, by the OLD key, over a public artifact — and it
    // attested to the wrong proposition. Anyone who had merely watched a rotation go by could
    // replay it and receive every edge and every assertion chain of BOTH identities without
    // holding either key. The rotation still has a job: it says which key succeeds which, so a
    // responder can find records filed under the predecessor. It just cannot say who is asking.
    const challengeValue = proof['challenge'];
    const sigValue = proof['sig'];
    if (typeof challengeValue !== 'string' || typeof sigValue !== 'string') {
      return { verified: false, reason: '§6.6: proof must carry a challenge signed by the persona it names' };
    }

    if (proof['rotation'] !== undefined || proof['type'] === 'rotation') {
      const parsed = RotationSchema.safeParse(proof['rotation'] ?? proof);
      if (!parsed.success) return { verified: false, reason: 'malformed rotation statement' };
      const rotation = parsed.data;
      if (rotation.new !== request.persona) {
        return { verified: false, reason: '§1.7: the rotation does not name this persona as the successor' };
      }
      // Only the `sig` encoding has a defined signing preimage (§00 signing rule excludes a
      // field literally named `sig`); `sig_old`/`sig_new` are accepted by the schema for
      // interoperability but cannot be verified without inventing a preimage rule. Narrowest
      // reading: refuse rather than guess. Reported upstream as a spec contradiction.
      if (rotation.sig === undefined) {
        return { verified: false, reason: '§1.7: only the single-`sig` rotation encoding is verifiable' };
      }
      if (!verifyObject(rotation as unknown as Record<string, unknown>, rotation.old)) {
        return { verified: false, reason: '§1.7: rotation is not signed by the old key' };
      }
      // A rotation from a key we have never dealt with proves nothing about our records.
      if (!this.knowsParty(rotation.old)) {
        return { verified: false, reason: 'the rotated-from key is not a party to any edge here' };
      }
      // Succession established. Possession is still the challenge's job, checked below.
      if (!this.issued.has(challengeValue)) {
        return { verified: false, reason: '§6.6: challenge is not one this responder issued, or is spent' };
      }
      if (!verifyObject({ challenge: challengeValue, sig: sigValue }, request.persona)) {
        return {
          verified: false,
          reason: '§6.6: the challenge is not signed by the persona being recovered — a rotation says which key succeeds which, not who is asking',
        };
      }
      return { verified: true, persona: rotation.new, predecessor: rotation.old };
    }

    const challenge = proof['challenge'];
    const sig = proof['sig'];
    if (typeof challenge !== 'string' || typeof sig !== 'string') {
      return { verified: false, reason: '§6.6: proof must be a rotation statement or a signed challenge' };
    }
    if (!this.issued.has(challenge)) {
      return { verified: false, reason: '§6.6: challenge is not one this responder issued, or is spent' };
    }
    if (!verifyObject({ challenge, sig }, request.persona)) {
      return { verified: false, reason: '§6.6: challenge signature does not verify under the persona' };
    }
    this.issued.delete(challenge);
    return { verified: true, persona: request.persona, predecessor: null };
  }

  /**
   * "All edges + assertion chains where the requester is a party." Verification happens here,
   * not at the call site, so an unverified request can only ever produce an empty response.
   */
  answer(request: RecoverRequest): { verdict: RecoveryVerdict; response: RecoverResponse } {
    const verdict = this.verifyRequest(request);
    if (!verdict.verified) return { verdict, response: { edges: [] } };

    const identities = [verdict.persona, verdict.predecessor].filter((x): x is string => x !== null);
    const edges: RecoverResponse['edges'] = [];
    for (const id of this.vault.listEdgeIds(this.persona)) {
      const edge = this.vault.getEdge(this.persona, id);
      if (!edge) continue;
      // §6.6 says "where the requester is a party" — so party-ship, not scope membership, is
      // what recovery restores. `mayServeEdge` is still consulted: it is the single M-4a choke
      // point, and a rule enforced in one place is a rule that cannot drift.
      if (!identities.some((who) => isParty(edge, who))) continue;
      if (!identities.some((who) => mayServeEdge(this.vault, this.persona, who, edge).serve)) continue;
      edges.push({ edge, assertions: this.vault.getAssertions(this.persona, id) });
    }
    return { verdict, response: { edges } };
  }

  private knowsParty(key: string): boolean {
    for (const id of this.vault.listEdgeIds(this.persona)) {
      const edge = this.vault.getEdge(this.persona, id);
      if (edge && isParty(edge, key)) return true;
    }
    return false;
  }
}
