import type { BriefView, CardView } from '@servanda/client-web';
import { COPY, THEME_CSS, briefEl, renderToHtml } from '@servanda/client-web';

/**
 * The brief as a push projection.
 *
 * "Identical content to the in-app Brief; one renderer contract" is taken literally: the
 * HTML part is the app's own brief element tree, serialised. There is no second opinion
 * about what the brief says, what order it says it in, or which action leads a card —
 * because there is no second implementation of any of that.
 *
 * A morning note is also the surface where a coaching voice would creep in first, so it
 * gets nothing the app does not have: no counts dressed as achievements, no streaks, no
 * nudge. Where things stand, and that is all.
 */

export interface BriefEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** The plain-text part. Same lines, same order, no markup. */
export function briefText(brief: BriefView): string {
  const lines: string[] = [brief.heading, brief.generatedLine, '', COPY.email.intro, ''];
  if (brief.cards.length === 0) lines.push(brief.empty, '');
  for (const card of brief.cards) lines.push(...cardText(card));
  if (brief.belowTheLine !== null) lines.push(brief.belowTheLine, '');
  lines.push(COPY.email.footer);
  return lines.join('\n');
}

function cardText(card: CardView): string[] {
  // Every action the app offers, primary first — an email that quietly dropped the rest
  // would be a second, smaller brief, which is the thing this projection must not become.
  const actions = card.actions.map((a) => `[${a.label}]`).join(' ');
  const withWhom =
    card.withWhom === null
      ? `${card.seal.label} · ${COPY.party.justYou}`
      : `${card.seal.label} · ${card.withWhom.display} · ${card.withWhom.trust.label}`;
  return [actions, card.what, withWhom, card.ifIDoNothing, ''];
}

/**
 * The HTML part. The stylesheet is inlined in a `<style>` block because an email client
 * cannot be asked to fetch one — the same reason the theme names no webfont URL.
 */
export function briefHtml(brief: BriefView): string {
  const body = renderToHtml(briefEl(brief));
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${COPY.brief.heading}</title>`,
    `<style>${THEME_CSS}</style>`,
    '</head><body>',
    `<div class="servanda">${body}`,
    `<p class="generated">${COPY.email.footer}</p>`,
    '</div></body></html>',
  ].join('');
}

export function renderBriefEmail(brief: BriefView): BriefEmail {
  return {
    subject: COPY.email.subject(brief.counts.owe, brief.counts.waiting),
    text: briefText(brief),
    html: briefHtml(brief),
  };
}
