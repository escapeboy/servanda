import { z } from 'zod';
import { PersonaId, ProtocolVersion, Rfc3339, Sha256Hex, SignatureHex } from './primitives.js';
import { Assertion, Edge } from './edge.js';
import { Attestation, Revocation, Rotation } from './identity.js';
import { Publish, Unpublish } from './scope.js';

/**
 * §6.2 Wire messages. All messages: { v, type, payload, sender, recipient, sent_at, sig }.
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
  /**
   * §6.2 — who the message is FOR, inside the signed preimage.
   *
   * Without it a signature says "this persona wrote this" and nothing about whom they wrote it
   * to, so any recipient can re-seal a validly-signed message to a third party and it verifies
   * there unchanged. §6.3's courier is anonymous by design and authenticates nobody, so the
   * signature is the only place the binding can live.
   *
   * A recipient MUST discard a message whose `recipient` is not itself, before anything else.
   * `propose` and `assert` have their own party checks, but those are per-type rules each new
   * message type has to remember to re-derive; this one holds for every type there will ever be.
   */
  recipient: PersonaId,
  sent_at: Rfc3339,
  sig: SignatureHex,
});
export type WireMessage = z.infer<typeof WireMessage>;

/**
 * §6.7 inbox record — where a persona says its mail should go.
 *
 * `hubs` is ORDERED, most-preferred first, and the order is normative: a sender must walk it as
 * written. It is typed as a plain array because there is no way to make "do not sort this" a type,
 * which is exactly why §6.7 states it as a MUST NOT and `hubsFor` hands the list back untouched.
 *
 * M-17: the signature is verified against `persona` — the record carries its own verification key,
 * so no registry and no hub cooperation is involved in deciding whether to believe it.
 */
export const InboxRecord = z.object({
  v: ProtocolVersion,
  type: z.literal('inbox'),
  persona: PersonaId,
  hubs: z.array(z.string().min(1)),
  /**
   * §6.3 key agreement — the persona's X25519 public key, hex.
   *
   * It rides HERE rather than in a statement of its own, and the reason is §1.2. Personas from
   * one seed are unlinkable to anyone without the seed; a second published record would be a
   * second thing an observer could compare. A persona reachable over a hub must already publish
   * this one, so a field on it adds no correlation handle that reachability did not already cost.
   *
   * It is authenticated by the rule that already guards this record: M-17 says only the persona
   * key may alter it, so a DH key arriving inside a record whose signature verifies against the
   * persona it names is bound to that persona already.
   *
   * Rotation comes free with the record's 30-day life: publish a new one, and senders stop using
   * the old key when the old record expires.
   *
   * Required as of upstream #33. It was optional while that was a proposal, because the vendored
   * vectors predated it and a vector is never edited to suit an implementation. They carry it now.
   */
  dh_key: z.string().regex(/^[0-9a-f]{64}$/),
  issued_at: Rfc3339,
  sig: SignatureHex,
});
export type InboxRecord = z.infer<typeof InboxRecord>;

/** §6.3 blind-courier envelope as a hub sees it: recipient, ciphertext, timestamps. Nothing else. */
export const HubEnvelope = z.object({
  v: ProtocolVersion,
  type: z.literal('hub_envelope'),
  recipient: PersonaId,
  sealed: z.object({
    v: ProtocolVersion,
    /** The HPKE encapsulated key — an ephemeral X25519 public key (RFC 9180 §4.1). */
    epk: z.string().regex(/^[0-9a-f]{64}$/),
    /**
     * No `nonce`. HPKE derives it from the key schedule (RFC 9180 §5.1), so it never travels and
     * cannot be chosen, reused or tampered with by whoever assembles the envelope. The
     * hand-rolled construction carried a 24-byte random one because it had no schedule to derive
     * from — one fewer field on the wire is one fewer thing a courier sees and a sender can get
     * wrong.
     */
    ciphertext: z.string().regex(/^[0-9a-f]+$/),
  }),
  sent_at: Rfc3339,
});
export type HubEnvelope = z.infer<typeof HubEnvelope>;
