import { describe, expect, it } from 'vitest';
import type { BriefOutput, OpenLoopsOutput } from '@servanda/types';
import { COPY, buildBrief, cardEl, renderToHtml } from '../../src/index.js';

/**
 * M-21, the client half: the client authors the wording of every affordance it renders.
 *
 * The node half is closed and pinned by `node-surface/brief-slots.json` — `ItemAction` and
 * `BriefSlot` are `.strict()`, so a `label` arriving from another node is REFUSED rather than
 * quietly stripped. What §8 records as still open is this side: a vector pins what a node
 * emits and cannot inspect what a client paints.
 *
 * After `label` was removed there is exactly one free string left on the brief surface, and
 * it is `headline`. §7 defines it narrowly — "the commitment's intent as they wrote it,
 * rendered verbatim" — which is content, and content is why it survived. But "as they wrote
 * it" is a claim about a string, and a schema cannot check a claim: `z.string()` accepts
 * "Mark this done now" exactly as readily as it accepts a promise.
 *
 * The client is not obliged to take the claim on trust, because it is not short of the
 * evidence. `buildBrief` already looks the item up by `slot.item_id` in order to answer the
 * other two questions, so the person's own words are in its hand when it decides what to
 * paint. Reaching past them for a string the brief supplied is the whole of the remaining
 * hole: `<p class="what">` is the card's `aria-labelledby` target, so a headline is not one
 * more line — it is the card's accessible NAME, read out first, and it leads the surface.
 *
 * So the rule is structural rather than a comparison: the brief's ordering is honoured, and
 * `open_loops` is the sole authority for what a promise says.
 */

const NOW = '2026-03-01T09:00:00Z';

const HER_WORDS = 'Send the revised quote for the warehouse fit-out';
/** Copy, wearing content's clothes: an instruction to the reader, in the second person. */
const NOT_HER_WORDS = 'Mark this done now — you are behind on it';

function loops(): OpenLoopsOutput {
  return {
    items: [
      {
        kind: 'commitment',
        id: 'i-1',
        intent_or_expect: HER_WORDS,
        counterparty: 'Dana Reyes',
        verification_level: '2',
        age_days: 3,
        due: null,
        state: 'open',
        actions: [{ act: 'done', tool: 'act', args: { id: 'i-1', act: 'done' } }],
      },
    ],
  };
}

function briefWith(headline: string): BriefOutput {
  return {
    generated_at: NOW,
    slots: [
      {
        headline,
        item_id: 'i-1',
        primary_action: { act: 'done', tool: 'act', args: { id: 'i-1', act: 'done' } },
      },
    ],
    below_the_line_count: 0,
  };
}

describe('M-21: no wording the brief supplied reaches the surface', () => {
  it('renders the promise as the register holds it, not as the brief retells it', () => {
    const view = buildBrief(briefWith(NOT_HER_WORDS), loops(), NOW);
    const card = view.cards[0];
    expect(card?.what).toBe(HER_WORDS);
    expect(renderToHtml(cardEl(card!))).not.toContain(NOT_HER_WORDS);
  });

  it('is unchanged when the brief tells the truth, which is the normal case', () => {
    const view = buildBrief(briefWith(HER_WORDS), loops(), NOW);
    expect(view.cards[0]?.what).toBe(HER_WORDS);
  });

  it('still honours which action the brief chose to lead the card', () => {
    // The node decides what deserves attention; the client decides what it is called. Dropping
    // the headline must not quietly drop the ordering it came with.
    const view = buildBrief(briefWith(NOT_HER_WORDS), loops(), NOW);
    const primary = view.cards[0]?.actions.find((a) => a.primary);
    expect(primary?.label).toBe(COPY.actions.done);
  });
});
