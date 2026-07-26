import { COPY } from '@servanda/client-web';
import type { GestureCard } from '../card.js';
import { AT_MEETING_END, confirmCard, expectationCard } from '../card.js';
import type { PersonaDirectory } from '../ports.js';
import { quote } from '../quote.js';
import type { Speaker, Utterance } from '../utterance.js';
import { asOwn } from '../utterance.js';

/**
 * The meeting-end card: the same card object, delivered at a different moment.
 *
 * Business promises are made mostly out loud, and transcript services already produce action
 * items. This adapter takes that list and turns it into the same cards a reaction produces —
 * same three questions, same intents, same M-1 boundary — delivered when the meeting ends
 * rather than when somebody taps. The only difference is `delivery.moment`, which is
 * `batched`: the whole point of a meeting-end card is that it is not an interruption.
 *
 * The list is a set of claims about who said what. The claims are attacker-authored in
 * exactly the way a chat message is — a transcript is a machine's reading of a room — so
 * they get the same treatment: quoted, and never allowed to say whose promise it is. An item
 * attributed to somebody other than the person reading the card becomes a note that they are
 * waiting, never that person's promise.
 */

export interface MeetingParticipant {
  readonly external_id: string;
  readonly display_name: string;
}

export interface MeetingActionItem {
  readonly id: string;
  readonly text: string;
  /** Whom the transcript thinks said it. A claim, resolved through the directory. */
  readonly owner_external_id: string | null;
  readonly owed_to_external_id: string | null;
}

export interface MeetingEndPayload {
  readonly meeting_id: string;
  readonly ended_at: string;
  readonly participants: readonly MeetingParticipant[];
  readonly action_items: readonly MeetingActionItem[];
}

function participantSpeaker(
  externalId: string | null,
  payload: MeetingEndPayload,
  directory: PersonaDirectory,
): Speaker | null {
  if (externalId === null) return null;
  const participant = payload.participants.find((p) => p.external_id === externalId);
  const known = directory.lookup(externalId);
  return {
    display: quote(participant?.display_name ?? COPY.party.unknown),
    externalId,
    personaId: known?.personaId ?? null,
    verification: known?.verification ?? '0',
  };
}

export function meetingUtterance(
  item: MeetingActionItem,
  payload: MeetingEndPayload,
  directory: PersonaDirectory,
): Utterance {
  // An item the transcript could not attribute is nobody's promise, so it is somebody
  // unnamed's — which is an expectation, never a commitment (M-1).
  const speaker = participantSpeaker(item.owner_external_id, payload, directory) ?? {
    display: quote(COPY.party.unknown),
    externalId: '',
    personaId: null,
    verification: '0' as const,
  };
  return {
    place: 'meeting',
    ref: { kind: 'message', value: `${payload.meeting_id}/${item.id}` },
    speaker,
    text: quote(item.text),
    occurredAt: payload.ended_at,
    // A transcript action item is already a queued extraction: it is a reading of what was
    // said, waiting for the person who said it to agree that it is what they meant.
    pendingId: item.id,
    owedTo: participantSpeaker(item.owed_to_external_id, payload, directory),
  };
}

/**
 * Every action item, as a card, in the order the transcript produced them. Items the reader
 * said themselves become confirm cards; everything else becomes something they are waiting
 * for. No branch produces a promise owned by anyone but the person tapping (M-1).
 */
export function meetingEndCards(
  payload: MeetingEndPayload,
  directory: PersonaDirectory,
  viewer: string,
): GestureCard[] {
  return payload.action_items.map((item) => {
    const utterance = meetingUtterance(item, payload, directory);
    const mine = asOwn(utterance, viewer);
    return mine === null
      ? expectationCard(utterance, item.id, AT_MEETING_END)
      : confirmCard(mine, item.id, AT_MEETING_END);
  });
}
