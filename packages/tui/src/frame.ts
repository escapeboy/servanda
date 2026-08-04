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
import { COPY, STANDALONE_SURFACES, SURFACES, escapeLine, stopsFor } from '@servanda/client-web';

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
  /**
   * Which register this is — your own, or the demonstration on invented promises. It belongs
   * to the frame rather than to the entry point that knows the answer, because a line written
   * once above the frame is a line that can be lost: Ink clears the whole terminal the moment
   * the frame is taller than the window, which any register with a few cards is, and it never
   * came back. A sample that survives its own label is a sample mistakable for a register.
   */
  readonly banner?: string | undefined;
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
 * The renderer's last act, on every line it emits — `escapeLine`, which is the shared rule
 * for every medium whose structure is where the lines break. The morning mail's text part
 * needs the same treatment for the same reasons, and had none until it shared this one.
 *
 * Nothing this file writes contains either class, so this can never alter the interface's own
 * words: the marks are ASCII parentheses and the rule is a box-drawing dash.
 */
export function frameLines(state: FrameState): string[] {
  return composeLines(state).map(escapeLine);
}

function composeLines(state: FrameState): string[] {
  const stops: Stop[] = stopsFor(state.app);
  const focused = stops[state.cursor]?.id ?? null;
  // A standalone surface has no navigation in the browser, so it has none here either.
  const standalone = STANDALONE_SURFACES.includes(state.app.surface);
  const head = state.banner === undefined ? [] : [state.banner];
  const lines: string[] = standalone
    ? [...head, COPY.appName, RULE]
    : [...head, COPY.appName, navLine(state.app.surface, focused), RULE];

  // Whether this screen is the register or part of it, said once, before any body.
  //
  // Placed here rather than in each branch below for the reason the count itself exists: the
  // browser has one call site and the terminal must not need seven, or six of them will be
  // correct and the seventh will quietly print a prefix. `brief.unresolvedLine` on line ~208 is
  // the precedent — a number that sat on the view model while nothing rendered it, long enough
  // for a brief with two unreachable slots to print "Nothing is waiting on you today."
  if (state.app.reach.line !== null) lines.push(state.app.reach.line, '');

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
    if (state.app.brief.unresolvedLine !== null) lines.push(state.app.brief.unresolvedLine);
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
