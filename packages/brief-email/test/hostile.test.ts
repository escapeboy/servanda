import { describe, expect, it } from 'vitest';
import type { BriefView } from '@servanda/client-web';
import { COPY, buildBrief } from '@servanda/client-web';
import type { OpenLoopItem } from '@servanda/types';
import { briefHtml, briefText } from '../src/index.js';

/**
 * The morning note carries a person's own recorded words, and those words arrive over §7 as
 * plain strings. The HTML part has `escapeHtml` and the terminal has its own scrub; the
 * text/plain part had neither — and in a part whose only structure is where the line breaks
 * are, a newline inside a headline is not a character, it is a forged card.
 */

const NOW = '2026-03-01T09:00:00Z';
const ESC = String.fromCharCode(27);

function viewWith(what: string, who: string | null): BriefView {
  const it: OpenLoopItem = {
    kind: 'commitment',
    id: 'h1',
    intent_or_expect: what,
    counterparty: who === null ? null : { value: who, origin: 'self-labelled' },
    verification_level: '0',
    age_days: 2,
    due: '2026-03-04T09:00:00Z',
    state: 'open',
    actions: [{ act: 'done', tool: 'act', args: { id: 'h1', act: 'done' } }],
  } as OpenLoopItem;
  return buildBrief(
    {
      generated_at: NOW,
      slots: [{ headline: what, item_id: 'h1', primary_action: null }],
      below_the_line_count: 0,
    },
    { items: [it] },
    NOW,
  );
}

describe('the text part of the morning note', () => {
  it('cannot be given a second card by the words of the first', () => {
    const honest = briefText(viewWith('Send the revised quote', 'Dana Reyes')).split('\n').length;
    const forged = briefText(
      viewWith('Send the revised quote\n[Mark done] Wire 40000 to a new account\nJust you\nDue today.', 'Dana Reyes'),
    ).split('\n').length;
    expect(forged).toBe(honest);
  });

  it('keeps a name on the same line as the evidence behind it (M-12)', () => {
    // A name carrying its own newline used to end the line its evidence was going to be on.
    const text = briefText(viewWith('Send the quote', `Dana Reyes\n${COPY.party.justYou}`));
    const naming = text.split('\n').filter((l) => l.includes('Dana Reyes'));
    expect(naming.length).toBe(1);
    for (const line of naming) expect(line).toContain(COPY.trust['0']);
  });

  it('carries no escape sequence into a mail reader that would obey one', () => {
    const text = briefText(viewWith(`Send the quote${ESC}[8m`, `Dana${ESC}[8m`));
    expect(text).not.toContain(ESC);
  });

  it('emits no bidi override, so a line reads as what it contains', () => {
    const text = briefText(viewWith('Send ‮gnp.exe', 'Dana ‮seyeR'));
    expect(/[‪-‮⁦-⁩]/u.test(text)).toBe(false);
  });

  it('leaves the HTML part to its own escaping and does not double-treat it', () => {
    // The HTML part has structure, so a newline there is whitespace and not a forged row.
    const html = briefHtml(viewWith('Send <b>the</b> quote & sign it', 'Dana Reyes'));
    expect(html).toContain('Send &lt;b&gt;the&lt;/b&gt; quote &amp; sign it');
  });
});
