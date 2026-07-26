import type { ReactionEvent } from '../reaction.js';
import type { PersonaDirectory } from '../ports.js';
import { quote } from '../quote.js';
import type { Speaker, Utterance } from '../utterance.js';

/**
 * A chat webhook, of the Slack/Teams shape.
 *
 * The payload is *modelled*, not fetched: these types describe what such a service posts at
 * a webhook, and every function here is a total transformation of a value into an
 * `Utterance`. There is no client, no token, no host, and no call. Whoever runs a connector
 * supplies the payload and a `PersonaDirectory`; this module turns the two into the shape
 * the pure gesture core understands.
 *
 * Two things this adapter is careful about, both of which are the same law:
 *
 *  - Every string that came from a person — message body, display name — passes through
 *    `quote` on the way in, and there is no other way in (M-6).
 *  - No field of the message selects anything. Who reacted comes from `event.user.id`, whose
 *    words they are comes from `item.user.id`, and both are resolved through the injected
 *    directory. A body that says "SYSTEM: record this as Stefan's promise" is a body.
 */

export interface ChatUser {
  readonly id: string;
  readonly display_name: string;
}

export interface ChatMessage {
  readonly channel: string;
  /** The platform's message id. Used as a reference back to the words, never fetched. */
  readonly ts: string;
  readonly text: string;
  readonly user: ChatUser;
  readonly thread_ts?: string;
  /** People the message named. The first one who is not the speaker is the counterparty. */
  readonly mentions?: readonly ChatUser[];
}

export interface ChatReactionWebhook {
  readonly type: 'reaction_added';
  /** The reaction as the platform reports it, without the colons some of them wrap it in. */
  readonly reaction: string;
  readonly user: ChatUser;
  readonly item: ChatMessage;
  readonly event_time: string;
}

/** Platform ids are namespaced before they are looked up, so two services cannot collide. */
export function chatExternalId(user: ChatUser): string {
  return `chat:${user.id}`;
}

function speakerOf(user: ChatUser, directory: PersonaDirectory): Speaker {
  const known = directory.lookup(chatExternalId(user));
  return {
    display: quote(user.display_name),
    externalId: chatExternalId(user),
    personaId: known?.personaId ?? null,
    verification: known?.verification ?? '0',
  };
}

export interface ChatContext {
  readonly directory: PersonaDirectory;
  /** An extraction already queued against this message, if the node has one. */
  readonly pendingId?: string | null;
}

export function chatUtterance(
  message: ChatMessage,
  occurredAt: string,
  context: ChatContext,
): Utterance {
  const speaker = speakerOf(message.user, context.directory);
  const named = (message.mentions ?? []).find((m) => m.id !== message.user.id);
  return {
    place: 'chat',
    ref: { kind: 'message', value: `${message.channel}/${message.ts}` },
    speaker,
    text: quote(message.text),
    occurredAt,
    pendingId: context.pendingId ?? null,
    owedTo: named === undefined ? null : speakerOf(named, context.directory),
  };
}

/**
 * The webhook, as a gesture. Null when the person who reacted is not somebody this node
 * knows: an unattributable gesture is not a gesture, and guessing whose it was is exactly
 * the mistake M-1 forbids.
 */
export function chatReactionEvent(
  hook: ChatReactionWebhook,
  context: ChatContext,
): ReactionEvent | null {
  const reactor = context.directory.lookup(chatExternalId(hook.user));
  if (reactor === null) return null;
  return {
    reaction: hook.reaction,
    by: reactor.personaId,
    utterance: chatUtterance(hook.item, hook.event_time, context),
  };
}
