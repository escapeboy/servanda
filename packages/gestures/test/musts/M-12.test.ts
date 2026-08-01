import type { VerificationLevel } from '@servanda/types';
import { VERIFICATION_LEVEL_LABELS } from '@servanda/types';
import { COPY, RELIEF_BY_LEVEL, RELIEF_RANK, partyFor, visibleText, walk } from '@servanda/client-web';
import { describe, expect, it } from 'vitest';
import {
  MILA,
  STEFAN,
  asOwn,
  confirmCard,
  everyCard,
  expectationCard,
  gestureCardEl,
  meetingEndCards,
  meetingFixture,
  fixtureDirectory,
  quote,
  utteranceFixture,
} from '../../src/index.js';

const LEVELS = Object.keys(VERIFICATION_LEVEL_LABELS) as VerificationLevel[];

/**
 * M-12: a client displays the verification level, and never renders a display name above the
 * evidence that stands behind it.
 *
 * A gesture card is the sharpest case in the product for this rule. It is shown inside
 * somebody else's chat window, where the display name beside it is whatever that platform
 * lets a person type — and where a name with no evidence beside it reads as a vouched
 * identity purely because of the company it keeps. So the card carries the level with the
 * name, from the same values, with no branch that emits one without the other.
 */
describe('M-12: a gesture card never shows a name above its evidence', () => {
  it('shows the level beside the name, at every level', () => {
    for (const level of LEVELS) {
      const utterance = utteranceFixture({
        owedTo: {
          display: quote('stefan'),
          externalId: 'chat:U-4102',
          personaId: STEFAN,
          verification: level,
        },
      });
      const own = asOwn(utterance, MILA);
      if (own === null) throw new Error('fixture: the speaker must be the viewer');
      const card = confirmCard(own, 'pending-1');

      expect(card.withWhom).not.toBeNull();
      expect(card.withWhom!.trust.level).toBe(level);
      expect(card.withWhom!.trust.relief).toBe(RELIEF_BY_LEVEL[level]);

      const read = visibleText(gestureCardEl(card));
      expect(read).toContain(card.withWhom!.display);
      expect(read).toContain(COPY.trust[level]);
      // The relief rendered never exceeds what the evidence carries.
      expect(RELIEF_RANK[card.withWhom!.trust.relief]).toBeLessThanOrEqual(
        RELIEF_RANK[RELIEF_BY_LEVEL[level]],
      );
    }
  });

  it('has no card, anywhere, that renders a name without its evidence beside it', () => {
    const cards = [...everyCard(), ...meetingEndCards(meetingFixture(), fixtureDirectory(), MILA)];
    for (const card of cards) {
      const tree = gestureCardEl(card);
      const names = walk(tree).filter((n) => String(n.attrs?.['class'] ?? '').startsWith('party'));
      const evidence = walk(tree).filter((n) => String(n.attrs?.['class'] ?? '').startsWith('trust'));
      if (card.withWhom === null) {
        // "Just you" is not a name, so there is no evidence level owed beside it.
        expect(visibleText(tree)).toContain(COPY.party.justYou);
        expect(evidence).toHaveLength(0);
        continue;
      }
      expect(names.length).toBeGreaterThan(0);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.attrs?.['data-level']).toBe(card.withWhom.trust.level);
    }
  });

  it('shows an unresolvable speaker at level 0 rather than at no level at all', () => {
    const stranger = utteranceFixture({
      speaker: {
        display: quote('someone'),
        externalId: 'chat:U-9999',
        personaId: null,
        verification: '0',
      },
    });
    const card = expectationCard(stranger, 'x');
    expect(card.withWhom?.trust.level).toBe('0');
    expect(visibleText(gestureCardEl(card))).toContain(COPY.trust['0']);
  });

  it('the check can fail: a name rendered without evidence is detectable', () => {
    // A hand-built pair, deliberately missing its evidence node — the shape the renderer must
    // never produce. If this assertion stopped failing, the test above would prove nothing.
    const party = partyFor({ value: 'stefan', origin: 'attested' }, '3');
    const rogue = { tag: 'p', attrs: {}, children: [{ tag: 'span', attrs: { class: 'party' }, text: party!.display }] };
    const evidence = walk(rogue).filter((n) => String(n.attrs?.['class'] ?? '').startsWith('trust'));
    expect(evidence).toHaveLength(0);
  });
});
