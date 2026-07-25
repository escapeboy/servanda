import { z } from 'zod';
import { PersonaId, ProtocolVersion, Rfc3339, Sha256Hex, SignatureHex } from './primitives.js';
import { Assertion, Edge } from './edge.js';
import { Attestation, Revocation, Rotation } from './identity.js';
import { Publish, Unpublish } from './scope.js';

/**
 * §6.2 Wire messages. All messages: { v, type, payload, sender, sent_at, sig }.
 */

export const WireMessageType = z.enum([
  'propose',
  'assert',
  'publish',
  'unpublish',
  'attestation',
  'revocation',
  'rotation',
  'recon_request',
  'recon_response',
  'recover_request',
  'recover_response',
]);
export type WireMessageType = z.infer<typeof WireMessageType>;

/** §6.2 `propose` carries the edge plus its `proposed` assertion. */
export const ProposePayload = z.object({
  edge: Edge,
  assertion: Assertion,
});
export type ProposePayload = z.infer<typeof ProposePayload>;

export const AssertPayload = z.object({ assertion: Assertion });

/** §6.4 reconciliation. */
export const ReconRequestPayload = z.object({
  edges: z.array(z.object({ edge_id: Sha256Hex, latest_assertion_hash: Sha256Hex })),
});
export const ReconResponsePayload = z.object({
  edges: z.array(z.object({ edge_id: Sha256Hex, assertions: z.array(Assertion) })),
});

/**
 * §6.6 edge recovery. Responders MUST NOT include plaintext — hashes only;
 * plaintext recovery is a human act between counterparties.
 */
export const RecoverRequestPayload = z.object({
  persona: PersonaId,
  proof: z.union([Rotation, z.object({ challenge: z.string(), sig: SignatureHex })]),
});
export const RecoverResponsePayload = z.object({
  edges: z.array(z.object({ edge: Edge, assertions: z.array(Assertion) })),
});

export const WirePayload = z.union([
  ProposePayload,
  AssertPayload,
  Publish,
  Unpublish,
  Attestation,
  Revocation,
  Rotation,
  ReconRequestPayload,
  ReconResponsePayload,
  RecoverRequestPayload,
  RecoverResponsePayload,
]);

export const WireMessage = z.object({
  v: ProtocolVersion,
  type: WireMessageType,
  payload: z.unknown(),
  sender: PersonaId,
  sent_at: Rfc3339,
  sig: SignatureHex,
});
export type WireMessage = z.infer<typeof WireMessage>;

/** §6.3 blind-courier envelope as a hub sees it: recipient, ciphertext, timestamps. Nothing else. */
export const HubEnvelope = z.object({
  v: ProtocolVersion,
  type: z.literal('hub_envelope'),
  recipient: PersonaId,
  sealed: z.object({
    v: ProtocolVersion,
    epk: z.string().regex(/^[0-9a-f]{64}$/),
    nonce: z.string().regex(/^[0-9a-f]{48}$/),
    ciphertext: z.string().regex(/^[0-9a-f]+$/),
  }),
  sent_at: Rfc3339,
});
export type HubEnvelope = z.infer<typeof HubEnvelope>;
