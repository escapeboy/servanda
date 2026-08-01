import { z } from 'zod';

/** Spec §00 Conventions — protocol version string carried by every wire message. */
export const PROTOCOL_VERSION = 'servanda/0.2' as const;

export const ProtocolVersion = z.literal(PROTOCOL_VERSION);

/** §00: all hashes SHA-256, hex-encoded lowercase. */
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters (SHA-256)');

/** §1.2: persona_id = hex(ed25519 pubkey). Group keys share the shape. */
export const PublicKeyHex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters (Ed25519 public key)');

export const PersonaId = PublicKeyHex;
export const GroupKey = PublicKeyHex;
export const OrgRoot = PublicKeyHex;

export const SignatureHex = z
  .string()
  .regex(/^[0-9a-f]{128}$/, 'must be 128 lowercase hex characters (Ed25519 signature)');

/** §00: all timestamps RFC 3339, UTC. */
export const Rfc3339 = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    'must be an RFC 3339 timestamp',
  )
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be a parseable RFC 3339 timestamp');

/** §4.1 acceptance_window — ISO 8601 duration. */
export const Iso8601Duration = z
  .string()
  .regex(
    /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
    'must be an ISO 8601 duration such as P5D',
  );

/**
 * §3.1: `owed_to` may be a key or an `external_label` (a string, not a key) when the
 * counterparty is off-network. Kept as a distinct type so code cannot silently treat a
 * label as a routable identity.
 */
export const ExternalLabel = z.string().min(1).max(200);

export const KeyOrExternalLabel = z.union([PublicKeyHex, ExternalLabel]);

/** §1.6 binding proof ladder — clients MUST display the achieved level (M-12). */
export const VerificationLevel = z.enum(['0', '1', '2', '3', 'ext']);
export type VerificationLevel = z.infer<typeof VerificationLevel>;

export const VERIFICATION_LEVEL_LABELS: Record<VerificationLevel, string> = {
  '0': 'unconfirmed',
  '1': 'continuity',
  '2': 'attested',
  '3': 'domain-verified',
  ext: 'external-proof',
};
