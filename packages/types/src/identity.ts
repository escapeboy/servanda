import { z } from 'zod';
import {
  ProtocolVersion,
  PublicKeyHex,
  PersonaId,
  Rfc3339,
  SignatureHex,
} from './primitives.js';

/** §1.3 Attestation (`layer: wire`). claims are the org's assertions, not protocol truths. */
export const AttestationClaims = z
  .object({
    display_name: z.string().optional(),
    handle: z.string().optional(),
    /** §1.4: membership disclosure for group subjects; MAY be omitted cross-org. */
    members: z.array(PersonaId).optional(),
  })
  .passthrough();

export const Attestation = z.object({
  v: ProtocolVersion,
  type: z.literal('attestation'),
  org: PublicKeyHex,
  subject: PublicKeyHex,
  subject_kind: z.enum(['persona', 'group']),
  claims: AttestationClaims,
  issued_at: Rfc3339,
  expires_at: Rfc3339,
  sig: SignatureHex,
});
export type Attestation = z.infer<typeof Attestation>;

/** §1.3 Revocation. Edges signed before `revoked_at` remain valid (offboarding semantics). */
export const Revocation = z.object({
  v: ProtocolVersion,
  type: z.literal('revocation'),
  org: PublicKeyHex,
  subject: PublicKeyHex,
  revoked_at: Rfc3339,
  sig: SignatureHex,
});
export type Revocation = z.infer<typeof Revocation>;

/** §1.5 Domain anchor document served at /.well-known/servanda.json. */
export const DomainAnchor = z.object({
  v: ProtocolVersion,
  org_root: PublicKeyHex,
  hubs: z.array(z.string().url()).default([]),
});
export type DomainAnchor = z.infer<typeof DomainAnchor>;

/** §1.6 External binding proof published on a controlled channel. */
export const BindingProof = z.object({
  v: ProtocolVersion,
  type: z.literal('binding_proof'),
  persona: PersonaId,
  channel_url: z.string().url(),
  sig: SignatureHex,
});
export type BindingProof = z.infer<typeof BindingProof>;

/**
 * §1.6 Persona-linking statement — explicitly user-initiated only.
 * Both persona keys sign; proves common ownership without exposing the root.
 */
export const PersonaLink = z.object({
  v: ProtocolVersion,
  type: z.literal('link'),
  personas: z.tuple([PersonaId, PersonaId]),
  sig_A: SignatureHex,
  sig_B: SignatureHex,
});
export type PersonaLink = z.infer<typeof PersonaLink>;

/**
 * §1.7 Rotation. With the old key's signature, continuity transfers automatically:
 * verifiers MUST treat `new` as the successor for all open edges of `old`.
 *
 * RESOLVED UPSTREAM, and the resolution is worth keeping because it changed twice.
 *
 * §1.7 originally named the fields `sig_old` / `sig_new?` while §0's signing rule excluded only
 * a member literally named `sig`. Under those field names the preimage was undefined: neither
 * signature could exclude itself and each would have covered the other. This file therefore
 * accepted both encodings and emitted the single-`sig` form as the only one with a defined
 * preimage.
 *
 * BOTH halves of that reasoning have since moved. §0 now removes every member named `sig` or
 * beginning with `sig_`, so `sig_old` HAS a defined preimage — the same bytes `sig` covers. And
 * §1.7 withdrew the `sig_old`/`sig_new` encoding outright, on the ground that under the §0 rule
 * `sig_new` proves nothing `sig_old` does not and neither commits to the other's presence.
 *
 * What remains here is interoperability with objects written before the withdrawal, and nothing
 * more: `sig` is what this implementation emits and what §1.7 makes a MUST, `sig_old` parses so
 * that a legacy statement can be REPORTED rather than mistaken for corrupt, and accepting it
 * requires an explicit opt-in (`verifyRotation`'s `acceptLegacySigOld`).
 */
const RotationBase = z.object({
  v: ProtocolVersion,
  type: z.literal('rotation'),
  old: PublicKeyHex,
  new: PublicKeyHex,
  rotated_at: Rfc3339,
});

export const Rotation = RotationBase.extend({
  /** The conformance-oracle encoding: one signature by `old`, over the object minus `sig`. */
  sig: SignatureHex.optional(),
  /** The withdrawn §1.7 encoding. Parsed for interoperability only; see the note above. */
  sig_old: SignatureHex.optional(),
  sig_new: SignatureHex.optional(),
}).refine(
  (r) => r.sig !== undefined || r.sig_old !== undefined,
  'a rotation statement MUST carry the old key’s signature as `sig` (§00 signing rule) or `sig_old` (§1.7)',
);
export type Rotation = z.infer<typeof Rotation>;

/** The encoding §1.7 makes a MUST and this implementation emits: a single `sig` by `old`. */
export const RotationCanonical = RotationBase.extend({ sig: SignatureHex });
export type RotationCanonical = z.infer<typeof RotationCanonical>;
