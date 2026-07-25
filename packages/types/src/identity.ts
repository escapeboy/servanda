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
 * SPEC CONTRADICTION (filed upstream). §1.7 names the fields `sig_old` / `sig_new?`, but the
 * universal signing rule — `ed25519_sign(sha256(JCS(object minus "sig")), key)` (§00
 * Conventions, restated as the vectors' `signing_rule`) — excludes only a field literally
 * named `sig`. Under §1.7's field names the signing preimage is undefined: neither signature
 * can exclude itself, and each would have to cover the other. The conformance vectors resolve
 * this by emitting a single `sig` signed by the OLD key.
 *
 * Narrowest reading implemented here: accept both encodings, require at least one signature
 * by the old key, and never invent a preimage rule the spec does not state. `sig` is the form
 * this implementation emits, because it is the only one with a defined signing preimage.
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
  /** The §1.7 encoding. Retained for interoperability; see the note above. */
  sig_old: SignatureHex.optional(),
  sig_new: SignatureHex.optional(),
}).refine(
  (r) => r.sig !== undefined || r.sig_old !== undefined,
  'a rotation statement MUST carry the old key’s signature as `sig` (§00 signing rule) or `sig_old` (§1.7)',
);
export type Rotation = z.infer<typeof Rotation>;

/** The encoding this implementation emits: single `sig`, the only one with a defined preimage. */
export const RotationCanonical = RotationBase.extend({ sig: SignatureHex });
export type RotationCanonical = z.infer<typeof RotationCanonical>;
