import type { AppView, CardView, SealShape, Stop } from '@servanda/client-web';
import { COPY, SURFACES, stopsFor } from '@servanda/client-web';

/**
 * The terminal rendering: view model in, lines of text out.
 *
 * This is the whole renderer boundary. Everything above it — what a card says, which
 * action leads it, what order things come in — is the shared contract in
 * `@servanda/client-web`, so the terminal and the browser cannot drift apart in content.
 *
 * NOTE (reported deviation): the brief specified Ink for this surface. Ink and React are
 * not present in this workspace and this stream cannot install packages, so the renderer is
 * written as plain text with no dependency. The boundary is deliberately this one file:
 * an Ink component that emits these same lines is a wrapper, not a rewrite.
 */

/**
 * The seal in a terminal. The mark is a convenience; the words after it carry the meaning,
 * which is also what a screen reader on a terminal would read.
 */
const MARK: Record<SealShape, string> = {
  unsealed: '( )',
  half: '(=',
  joined: '(=)',
  marked: '(x)',
  cracked: '(/)',
  arrow: '(>)',
};

const RULE = '─'.repeat(64);

function actionsLine(card: CardView, focused: string | null): string {
  return card.actions
    .map((action) => (action.id === focused ? `> [${action.label}]` : `  [${action.label}]`))
    .join(' ');
}

function withWhomLine(card: CardView): string {
  const mark = MARK[card.seal.shape];
  if (card.withWhom === null) return `${mark} ${card.seal.label} · ${COPY.party.justYou}`;
  // M-12: the name and the evidence behind it are produced together, never separately.
  return `${mark} ${card.seal.label} · ${card.withWhom.display} · ${card.withWhom.trust.label}`;
}

export function cardLines(card: CardView, focused: string | null): string[] {
  return [actionsLine(card, focused), card.what, withWhomLine(card), card.ifIDoNothing, ''];
}

function navLine(current: string, focused: string | null): string {
  return SURFACES.map(({ id, label }) => {
    const marker = id === current ? `[${label}]` : ` ${label} `;
    return id === focused ? `>${marker}` : ` ${marker}`;
  }).join(' ');
}

export interface FrameState {
  readonly app: AppView;
  /** The stop the cursor is on, as an index into `stopsFor(app)`. */
  readonly cursor: number;
}

export function frameLines(state: FrameState): string[] {
  const stops: Stop[] = stopsFor(state.app);
  const focused = stops[state.cursor]?.id ?? null;
  const lines: string[] = [COPY.appName, navLine(state.app.surface, focused), RULE];

  if (state.app.surface === 'brief') {
    lines.push(state.app.brief.heading, state.app.brief.generatedLine, '');
    if (state.app.brief.cards.length === 0) lines.push(state.app.brief.empty, '');
    for (const card of state.app.brief.cards) lines.push(...cardLines(card, focused));
    if (state.app.brief.belowTheLine !== null) lines.push(state.app.brief.belowTheLine);
    return lines;
  }

  if (state.app.surface === 'inbox') {
    lines.push(state.app.inbox.heading, state.app.inbox.consequence, '');
    if (state.app.inbox.cards.length === 0) lines.push(state.app.inbox.empty, '');
    for (const card of state.app.inbox.cards) lines.push(...cardLines(card, focused));
    return lines;
  }

  const section = state.app.ledger.sections.find((s) => s.id === state.app.surface);
  if (section === undefined) return lines;
  lines.push(section.heading, '');
  if (section.cards.length === 0) lines.push(section.empty, '');
  for (const card of section.cards) lines.push(...cardLines(card, focused));
  return lines;
}

export function frame(state: FrameState): string {
  return frameLines(state).join('\n');
}
