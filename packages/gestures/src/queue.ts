import type { NodeClient } from '@servanda/client-web';
import type { OpenLoopItem } from '@servanda/types';
import type { ConfirmCard } from './card.js';
import { IN_SITU, confirmCard } from './card.js';
import type { Delivery } from './card.js';
import type { PlaceId } from './copy.js';
import { quote } from './quote.js';
import type { OwnUtterance, UtteranceRef } from './utterance.js';

/**
 * Cards for what is actually waiting, rather than for an utterance somebody happened to hold.
 *
 * `confirmCard` has always been able to build one — from an `OwnUtterance` a connector was
 * carrying, at the moment somebody reacted. What did not exist was the other direction: given
 * the confirmation queue, show me the cards. Without it a person could only meet a candidate by
 * being in the same conversation at the same moment, and everything §3 captured while nobody was
 * looking sat unseen.
 */

export interface QueueCardOptions {
  readonly client: NodeClient;
  /** The persona whose queue this is. Its items are, by construction, this person's own words. */
  readonly viewer: string;
  readonly place: PlaceId;
  /**
   * Where to point the card back at, per item.
   *
   * Supplied by the caller because the queue does not carry it: the §2 envelope knows the
   * session it came from, and by the time a candidate reaches `open_loops` that is gone. A
   * connector placing the card knows where it is placing it; this package does not, and
   * inventing a reference would be worse than asking for one.
   */
  readonly refFor: (item: OpenLoopItem) => UtteranceRef;
  readonly delivery?: Delivery;
  readonly limit?: number;
}

/**
 * `view: "pending"` holds two different things since §7's sentence was implemented in full: the
 * extraction queue AND inbound `proposed` edges. Only the first is somebody's own words awaiting
 * confirmation; an inbound proposal is a promise another person made and sent, which is not a
 * capture at all and must never be dressed as one.
 *
 * The distinction is `kind`. Extraction candidates are queued as `commitment`; an edge is an
 * `edge` for both parties. Filtering on it rather than on wording is what keeps this correct
 * when the queue grows a third occupant.
 */
export async function queueCards(options: QueueCardOptions): Promise<ConfirmCard[]> {
  const page = await options.client.open_loops({
    view: 'pending',
    persona: options.viewer,
    limit: options.limit ?? 50,
    cursor: null,
  });

  return page.items
    .filter((item) => item.kind === 'commitment')
    .map((item) => confirmCard(utteranceOf(item, options), item.id, options.delivery ?? IN_SITU));
}

/**
 * The item, as the utterance it came from.
 *
 * Cast to `OwnUtterance` without going through `asOwn`, and that needs saying rather than
 * hiding: `asOwn` gates on a speaker's resolved persona matching the viewer, which is the right
 * check when an utterance arrives from a chat platform where anybody may have said anything.
 * Here the provenance is different in kind — these items came out of THIS persona's own
 * confirmation queue, which `open_loops` scopes per persona and which nothing else can write to.
 * The speaker is the viewer by construction, and running a directory lookup would be checking a
 * fact the data structure already guarantees.
 *
 * What it must NOT do is widen: the filter above is what keeps somebody else's promise out, and
 * removing it would let this cast turn an inbound proposal into "your own words".
 */
function utteranceOf(item: OpenLoopItem, options: QueueCardOptions): OwnUtterance {
  const utterance = {
    place: options.place,
    ref: options.refFor(item),
    speaker: {
      display: quote(''),
      externalId: options.viewer,
      personaId: options.viewer,
      verification: '3' as const,
    },
    // Quoted, because it is the person's own words as a model read them back — content, and
    // never something this surface interprets (M-6).
    text: quote(item.intent_or_expect),
    occurredAt: new Date(0).toISOString(),
    pendingId: item.id,
    owedTo:
      item.counterparty === null
        ? null
        : {
            display: quote(item.counterparty.value),
            externalId: item.counterparty.value,
            personaId: null,
            verification: item.verification_level,
          },
  };
  return utterance as OwnUtterance;
}
