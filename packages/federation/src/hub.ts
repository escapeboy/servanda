import { z } from 'zod';
import { verifyObject } from '@servanda/crypto';
import type { HubEnvelope } from '@servanda/types';
import { HubEnvelope as HubEnvelopeSchema, PersonaId, PROTOCOL_VERSION, Rfc3339, SignatureHex } from '@servanda/types';

/**
 * A conforming hub (§6.3 + M-11), modelled in memory.
 *
 * §6.3: "A conforming hub sees: recipient persona_id, ciphertext, timestamps — nothing else."
 * That is a constraint on the HUB, not only on senders, so it is enforced here rather than
 * assumed: `deliver` parses with a STRICT schema and rejects any envelope carrying a field
 * outside the allowed set. A hub that accepted `{..., sender}` would be a hub that had been
 * handed the social graph, however well-behaved its senders happened to be.
 *
 * M-11 by construction: this class stores no sender and therefore cannot pair two parties, and
 * it exposes no method that counts, aggregates, or ranks anything. The absence is the feature —
 * `M-11.test.ts` asserts the method list, because a statistics endpoint added later would
 * otherwise be a silent conformance break.
 */

/** The exact field set a hub is permitted to see. §6.3, as data. */
export const HUB_VISIBLE_FIELDS: readonly string[] = ['v', 'type', 'recipient', 'sealed', 'sent_at'] as const;

/** §6.1: the inbox is "authenticated by persona signature challenge". */
export const InboxAuth = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('inbox_auth'),
  persona: PersonaId,
  /** The hub-issued nonce this signature answers. */
  challenge: z.string().min(16),
  issued_at: Rfc3339,
  sig: SignatureHex,
});
export type InboxAuth = z.infer<typeof InboxAuth>;

const StrictHubEnvelope = HubEnvelopeSchema.extend({
  sealed: HubEnvelopeSchema.shape.sealed.strict(),
}).strict();

export class HubRejection extends Error {
  override name = 'HubRejection';
}

export interface StoredEnvelope {
  envelope: HubEnvelope;
  received_at: string;
}

export interface MemoryHubOptions {
  now?: () => Date;
  /** §6.7 RECOMMENDS a queue TTL of ≥ 30 days. */
  ttlDays?: number;
  /** Deterministic nonces in tests; a real hub uses a CSPRNG. */
  nonce?: () => string;
}

export class MemoryHub {
  private readonly queue = new Map<string, StoredEnvelope[]>();
  private readonly challenges = new Map<string, string>();
  private readonly clock: () => Date;
  private readonly ttlMs: number;
  private readonly nonce: () => string;
  private counter = 0;

  constructor(opts: MemoryHubOptions = {}) {
    this.clock = opts.now ?? (() => new Date());
    this.ttlMs = (opts.ttlDays ?? 30) * 86_400_000;
    this.nonce = opts.nonce ?? (() => `nonce-${++this.counter}-${this.clock().getTime()}`);
  }

  /** `POST /servanda/v0/deliver`. */
  deliver(raw: unknown): { accepted: true } {
    const parsed = StrictHubEnvelope.safeParse(raw);
    if (!parsed.success) {
      // The refusal names the rule, because "unknown field" is exactly the interesting failure.
      throw new HubRejection(
        `§6.3: a hub accepts only { ${HUB_VISIBLE_FIELDS.join(', ')} }; rejected: ${parsed.error.issues
          .map((i) => i.path.join('.') || '(root)')
          .join(', ')}`,
      );
    }
    const envelope = parsed.data;
    const list = this.queue.get(envelope.recipient) ?? [];
    list.push({ envelope, received_at: this.clock().toISOString() });
    this.queue.set(envelope.recipient, list);
    return { accepted: true };
  }

  /** The nonce a persona must sign to read its inbox. */
  challenge(persona: string): string {
    const value = this.nonce();
    this.challenges.set(persona, value);
    return value;
  }

  /**
   * `GET /servanda/v0/inbox?persona=…`. §6.7: hubs "MUST deliver only to the persona".
   * The signature is checked against the persona named in the query, so possession of the
   * persona key — not knowledge of the persona id — is what opens the queue.
   */
  inbox(persona: string, auth: unknown): HubEnvelope[] {
    const parsed = InboxAuth.safeParse(auth);
    if (!parsed.success) throw new HubRejection('§6.1: inbox access requires a signed challenge');
    const a = parsed.data;
    if (a.persona !== persona) throw new HubRejection('§6.7: a hub delivers only to the persona itself');
    if (this.challenges.get(persona) !== a.challenge) {
      throw new HubRejection('§6.1: challenge is unknown or already spent');
    }
    if (!verifyObject(a as unknown as Record<string, unknown>, persona)) {
      throw new HubRejection('§6.1: challenge signature does not verify');
    }
    this.challenges.delete(persona);
    this.expire();
    return (this.queue.get(persona) ?? []).map((s) => s.envelope);
  }

  /**
   * Everything this hub holds. Not part of the hub API — the blind-courier test asserts on it,
   * which is only meaningful because it is the whole of the hub's state.
   */
  visibleState(): StoredEnvelope[] {
    return [...this.queue.values()].flat();
  }

  private expire(): void {
    const cutoff = this.clock().getTime() - this.ttlMs;
    for (const [persona, list] of this.queue) {
      const kept = list.filter((s) => Date.parse(s.received_at) >= cutoff);
      if (kept.length === 0) this.queue.delete(persona);
      else this.queue.set(persona, kept);
    }
  }
}
