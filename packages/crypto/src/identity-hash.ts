import { canonicalBytes } from './jcs.js';
import { concatBytes, sha256Hex, utf8 } from './hash.js';

/**
 * §0 Conventions — every identifier preimage begins with a domain tag: a fixed ASCII string
 * followed by a single `0x00` octet. The tag contains no `0x00`, so it is self-delimiting and
 * the octets after it are whatever the defining section says.
 *
 * Signing preimages are deliberately NOT tagged (see `sign.ts`): a signature is already bound to
 * its object by that object's own `type` and `v` members, which are inside the canonical form.
 * Tagging there would change every signature for nothing. The two rules live one file apart and
 * are easy to conflate, which is why each says what the other does not do.
 */
function domainTag(tag: string): Uint8Array {
  return concatBytes(utf8(tag), new Uint8Array([0x00]));
}

/**
 * §3.2 — commitment_hash = sha256(tag || JCS({intent, owner, owed_to, due, created_at})).
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

export const COMMITMENT_HASH_TAG = 'servanda/0.1:commitment_hash';

export function commitmentHash(c: CommitmentHashInput): string {
  return sha256Hex(
    concatBytes(domainTag(COMMITMENT_HASH_TAG), canonicalBytes(commitmentHashPreimage(c))),
  );
}

/**
 * §4.1 — edge_id = sha256(tag || commitment_hash || owner || owed_to || proposed_at).
 *
 * `||` is now defined: the four values contribute their own UTF-8 encodings — the ASCII text of
 * the lowercase hex digest and public keys, and of the RFC 3339 timestamp — with no separator and
 * no length prefix. §4.1 states the concatenation is unambiguous because the first three are
 * fixed-width at 64 octets and only the last varies, and that implementations MUST NOT decode the
 * hex values to their 32-octet binary form before hashing. That last clause is the whole of
 * upstream #10: the ambiguity was never the joining, it was whether `||` joined text or bytes.
 *
 * The tag composes rather than cancels: a tagged commitment_hash feeds a separately tagged
 * edge_id, so both digests change and neither undoes the other.
 *
 * Ratified as-is (upstream #11): the preimage still omits closure_policy, due, blocked_by and
 * supersedes, so two edges differing only in closure policy share an edge_id. The edge body is
 * bound on first sight instead. Reproduced here rather than worked around, so it stays visible.
 */
export const EDGE_ID_TAG = 'servanda/0.1:edge_id';

/**
 * §2 — the envelope `id` = sha256(tag || JCS(envelope sans id)).
 *
 * It lives here, next to the other two, because §0 states one rule for all three identifiers and
 * a rule gets exactly one home (ADR-0016). `envelope` calls this rather than hashing canonically
 * itself; splitting them would leave the next reader looking for the envelope's tag in a
 * different package from the other two.
 *
 * The §3.1 property this must not lose: `evidence_refs` point at these ids, so any change to
 * envelope content — including clipping — still has to change the id. Prefixing a constant tag
 * cannot collapse two distinct payloads onto one digest, so the property survives.
 */
export const ENVELOPE_ID_TAG = 'servanda/0.1:envelope_id';

export function envelopeId(envelopeSansId: unknown): string {
  return sha256Hex(concatBytes(domainTag(ENVELOPE_ID_TAG), canonicalBytes(envelopeSansId)));
}

/**
 * §4.1 concatenates the three hex fields with no separator between them, and that is ratified
 * exactly as implemented — the encoding is frozen and is not what this guard changes.
 *
 * What makes the concatenation unambiguous is that each field is exactly 64 octets, and nothing
 * enforced it. A 63-octet `commitment_hash` beside a 65-octet `owner` produces the same preimage
 * as the well-formed pair beside it, so two distinct edges share one `edge_id` — and an `edge_id`
 * is what an assertion chain is filed under. `proposed_at` needs no width because it is last:
 * nothing follows it to slide across.
 *
 * Rejecting a malformed field changes no valid identifier. Every input §4.1 permits produces
 * exactly the digest it produced before.
 */
const HEX64 = /^[0-9a-f]{64}$/;

export function edgeId(input: {
  commitment_hash: string;
  owner: string;
  owed_to: string;
  proposed_at: string;
}): string {
  for (const field of ['commitment_hash', 'owner', 'owed_to'] as const) {
    if (!HEX64.test(input[field])) {
      throw new TypeError(`edge_id: ${field} must be 64 lowercase hex characters, got ${JSON.stringify(input[field])}`);
    }
  }
  return sha256Hex(
    concatBytes(
      domainTag(EDGE_ID_TAG),
      utf8(input.commitment_hash),
      utf8(input.owner),
      utf8(input.owed_to),
      utf8(input.proposed_at),
    ),
  );
}
