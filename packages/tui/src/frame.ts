import type {
  ActionView,
  AppView,
  CardView,
  IntegrationsView,
  OnboardingView,
  ProofView,
  SealShape,
  Stop,
  TeamView,
} from '@servanda/client-web';
import { COPY, STANDALONE_SURFACES, SURFACES, stopsFor } from '@servanda/client-web';

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

/** A row of controls that does not belong to a card: sources, consents, first-run steps. */
function loneActionsLine(actions: readonly ActionView[], focused: string | null): string {
  return actions
    .map((action) => (action.id === focused ? `> [${action.label}]` : `  [${action.label}]`))
    .join(' ');
}

/**
 * The team standup, in text. Same entries, same order, same words — this is a rendering of
 * `TeamView`, so it cannot show anything the browser hides (M-4) or count anything (M-11).
 */
function teamLines(team: TeamView): string[] {
  const lines: string[] = [team.heading, team.lede, ''];
  if (team.entries.length === 0) lines.push(team.empty, '');
  for (const entry of team.entries) {
    const parties = entry.between.map((p) => `${p.display} · ${p.trust.label}`).join(' · ');
    lines.push(
      entry.what,
      `${MARK[entry.seal.shape]} ${entry.seal.label} · ${parties}`,
      entry.ifNothingHappens,
      entry.blocksLine,
      '',
    );
  }
  lines.push(team.note);
  return lines;
}

/** Sources and trust. The rungs are lines of text here for the same reason they are spans
 *  in the browser: they are a reading, and there is nothing to press. */
function integrationsLines(view: IntegrationsView, focused: string | null): string[] {
  const lines: string[] = [view.heading, '', view.sourcesHeading, ''];
  for (const source of view.sources) {
    lines.push(loneActionsLine([source.action], focused), source.label, source.status, source.lastRead, '');
  }
  lines.push(view.trustHeading, view.trustLede, '');
  for (const workClass of view.classes) {
    lines.push(workClass.label);
    for (const rung of workClass.rungs) {
      lines.push(`  ${rung.label} · ${rung.stateLabel}${rung.explains === null ? '' : ` · ${rung.explains}`}`);
    }
    lines.push('');
  }
  return lines;
}

function onboardingLines(view: OnboardingView, focused: string | null): string[] {
  const lines: string[] = [view.heading, view.lede, ''];
  for (const step of view.steps) {
    if (step.action !== null) lines.push(loneActionsLine([step.action], focused));
    lines.push(step.heading, step.blurb, '');
  }
  lines.push(view.custody, '');
  const sheet = view.recovery;
  lines.push(sheet.heading, loneActionsLine(sheet.actions, focused), sheet.blurb, sheet.wordsHeading);
  lines.push(...sheet.words, '', sheet.later);
  return lines;
}

function proofLines(view: ProofView, focused: string | null): string[] {
  const lines: string[] = [view.heading, view.lede, view.outcome, '', view.betweenHeading];
  for (const party of view.parties) {
    lines.push(`${party.role} · ${party.party.display} · ${party.party.trust.label}`, party.key);
  }
  lines.push('', view.datesHeading);
  for (const date of view.dates) lines.push(`${date.label} · ${date.value}`);
  lines.push('', view.chainHeading);
  for (const step of view.chain) {
    lines.push(
      // The mark is a convenience; the words carry the meaning, exactly as on a card.
      `${MARK[step.seal.shape]} ${step.seal.label} · ${step.label} · ${step.when} · ${step.signedBy}${step.evidence === null ? '' : ` · ${COPY.proof.evidence}`}`,
    );
  }
  lines.push('', view.fingerprintHeading, view.fingerprint, view.fingerprintNote);
  lines.push('', view.wordsHeading);
  if (view.words !== null) lines.push(view.words);
  lines.push(view.wordsNote);
  if (view.actions.length > 0) lines.push(loneActionsLine(view.actions, focused));
  return lines;
}

/**
 * What a terminal reads as an instruction rather than as a letter, and what makes a line read
 * differently from what it contains. Same two classes `@servanda/gestures` scrubs from a
 * quote, and for the same reason — except that here the text arrives over §7 rather than from
 * a chat platform, and §7's `intent_or_expect` and `counterparty` are plain unbounded strings.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'gu');
const BIDI_CHARS = new RegExp('[\\u202A-\\u202E\\u2066-\\u2069]', 'gu');

/**
 * The renderer's last act, on every line it emits.
 *
 * The words of a promise are content and are shown verbatim (M-21) — but "verbatim" is about
 * the words, and a cursor-movement sequence is not a word. Left in, `ESC[8m` after a
 * counterparty's name conceals everything the terminal prints after it, which on a card is
 * the verification level: the name survives and its evidence does not, which is precisely
 * what M-12 forbids. Control characters become spaces so the line keeps its length rather
 * than closing up around what was removed; bidi overrides go entirely, because there is no
 * width for them to keep.
 *
 * Nothing this file writes contains either class, so this can never alter the interface's own
 * words: the marks are ASCII parentheses and the rule is a box-drawing dash.
 */
function terminalSafe(line: string): string {
  return line.replace(CONTROL_CHARS, ' ').replace(BIDI_CHARS, '');
}

export function frameLines(state: FrameState): string[] {
  return composeLines(state).map(terminalSafe);
}

function composeLines(state: FrameState): string[] {
  const stops: Stop[] = stopsFor(state.app);
  const focused = stops[state.cursor]?.id ?? null;
  // A standalone surface has no navigation in the browser, so it has none here either.
  const standalone = STANDALONE_SURFACES.includes(state.app.surface);
  const lines: string[] = standalone
    ? [COPY.appName, RULE]
    : [COPY.appName, navLine(state.app.surface, focused), RULE];

  if (state.app.surface === 'team') {
    lines.push(...teamLines(state.app.team));
    return lines;
  }

  if (state.app.surface === 'trust') {
    lines.push(...integrationsLines(state.app.integrations, focused));
    return lines;
  }

  if (state.app.surface === 'first-run') {
    lines.push(...onboardingLines(state.app.onboarding, focused));
    return lines;
  }

  if (state.app.surface === 'proof') {
    if (state.app.proof !== null) lines.push(...proofLines(state.app.proof, focused));
    return lines;
  }

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
