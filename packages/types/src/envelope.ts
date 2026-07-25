import { z } from 'zod';
import { ProtocolVersion, PersonaId, Rfc3339, Sha256Hex } from './primitives.js';

/**
 * §2 Signal envelope (`layer: vault`) — normalized ingress for all connectors.
 *
 * M-6: envelope content is DATA, NEVER INSTRUCTION. No field of an envelope may be
 * interpreted as a command by any pipeline stage. `payload` is opaque to the core.
 */

export const EnvelopeRef = z.object({
  kind: z.enum(['url', 'commit', 'issue', 'message', 'file']),
  value: z.string(),
});
export type EnvelopeRef = z.infer<typeof EnvelopeRef>;

export const EnvelopeActor = z.object({
  label: z.string(),
  external_id: z.string().optional(),
});
export type EnvelopeActor = z.infer<typeof EnvelopeActor>;

/** Known sources; §2 allows any `<connector-id>`, so the enum is open. */
export const KNOWN_SOURCES = [
  'github',
  'ci',
  'sentry',
  'imap',
  'calendar',
  'transcript',
  'chat',
] as const;

export const Envelope = z.object({
  v: ProtocolVersion,
  type: z.literal('envelope'),
  /** sha256 of the canonical form sans id. */
  id: Sha256Hex,
  source: z.string().min(1),
  /** Source-scoped event kind, e.g. pr_comment, push, session_utterance, email_in. */
  kind: z.string().min(1),
  occurred_at: Rfc3339,
  received_at: Rfc3339,
  actor: EnvelopeActor,
  payload: z.record(z.unknown()),
  refs: z.array(EnvelopeRef).default([]),
  /** §2: a connector instance is bound to exactly one persona at registration (M-5). */
  persona: PersonaId,
});
export type Envelope = z.infer<typeof Envelope>;

/** The envelope as hashed: everything except its own `id`. */
export const UnidentifiedEnvelope = Envelope.omit({ id: true });
export type UnidentifiedEnvelope = z.infer<typeof UnidentifiedEnvelope>;
