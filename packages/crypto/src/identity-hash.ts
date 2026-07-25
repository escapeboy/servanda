import { canonicalBytes } from './jcs.js';
import { concatBytes, sha256Hex, utf8 } from './hash.js';

/**
 * §3.2 — commitment_hash = sha256(JCS({intent, owner, owed_to, due, created_at})).
 *
 * Exactly these five fields. Evidence, confidence, source and conditions are vault-local:
 * two parties agreeing on a promise need not share evidence sets. The 14 hashing vectors
 * exist to prove no sixth field reaches this hash.
 */
export const COMMITMENT_HASHED_FIELDS = ['intent', 'owner', 'owed_to', 'due', 'created_at'] as const;

export interface CommitmentHashInput {
  intent: string;
  owner: string;
  owed_to: string | null;
  due: string | null;
  created_at: string;
}

export function commitmentHashPreimage(c: CommitmentHashInput): CommitmentHashInput {
  return {
    intent: c.intent,
    owner: c.owner,
    owed_to: c.owed_to,
    due: c.due,
    created_at: c.created_at,
  };
}

export function commitmentHash(c: CommitmentHashInput): string {
  return sha256Hex(canonicalBytes(commitmentHashPreimage(c)));
}

/**
 * §4.1 — edge_id = sha256(commitment_hash || owner || owed_to || proposed_at).
 *
 * `||` is undefined in the spec. The conformance vectors define it as concatenation of the
 * four values' UTF-8 bytes in that order, with no separator and no length prefix
 * (vectors/README.md interpretation #1). Filed upstream; this implementation follows the
 * vectors, which are the conformance oracle.
 *
 * Interpretation #2 (also upstream): the preimage omits closure_policy, due, blocked_by and
 * supersedes, so two edges differing only in closure policy share an edge_id. Reproduced
 * here rather than worked around, so the collision stays visible.
 */
export function edgeId(input: {
  commitment_hash: string;
  owner: string;
  owed_to: string;
  proposed_at: string;
}): string {
  return sha256Hex(
    concatBytes(
      utf8(input.commitment_hash),
      utf8(input.owner),
      utf8(input.owed_to),
      utf8(input.proposed_at),
    ),
  );
}
