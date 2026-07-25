import { PersonaId } from '@servanda/types';
import type { Envelope } from '@servanda/types';
import type { ArchaeologyOptions } from './archaeology.js';
import { archaeologyEnvelopes } from './archaeology.js';
import type { WebhookContext, WebhookDelivery } from './webhook.js';
import { envelopeFromWebhook } from './webhook.js';

export * from './archaeology.js';
export * from './envelope.js';
export * from './git.js';
export * from './webhook.js';

/**
 * §2 / M-5: "a connector instance is bound to exactly one persona at registration."
 *
 * The persona is a constructor argument and never a method argument. Mining two repos for
 * two org personas requires two connectors, which is exactly the separation M-5 demands.
 */
export class GithubConnector {
  readonly persona: string;

  constructor(options: { readonly persona: string }) {
    this.persona = PersonaId.parse(options.persona);
  }

  /** Mine a local clone. No network. */
  archaeology(options: ArchaeologyOptions): Envelope[] {
    return archaeologyEnvelopes(this.persona, options);
  }

  /** One webhook delivery (`X-GitHub-Event` + body). */
  fromWebhook(delivery: WebhookDelivery, ctx: WebhookContext): Envelope[] {
    const envelope = envelopeFromWebhook(delivery, this.persona, ctx);
    return envelope === undefined ? [] : [envelope];
  }
}
