import { COPY } from './copy.js';
import type { ActionView } from './view.js';

/**
 * First run — and the law it answers to, quoted because it is the whole specification:
 *
 * > the default path assumes zero technical vocabulary. Any surface, flow, or sentence that
 * > requires knowing what a node, vault, MCP, or ledger *is* has violated this document.
 *
 * Sign up → connect → first brief. Three steps, no wizard, no questions, and no word that
 * belongs to the technical path — which is parallel and equal, and is simply not this one.
 * `scanFirstRun` checks the sentences below rather than trusting that they were written
 * carefully; "the word install does not exist on this path" is doctrine, so it is a test.
 *
 * The recovery sheet is offered, skippable and printable, in those exact senses: it is
 * shown without being asked for, it has a control that moves past it, and it renders to
 * something a printer can take. Skipping is not a smaller path — it is the same path.
 */

export const FIRST_RUN_STEPS = ['sign-up', 'connect', 'first-brief'] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

export interface OnboardingInput {
  /** Where the person is. Everything before it is done; everything after is ahead. */
  readonly step?: FirstRunStep;
  /**
   * The recovery words, produced elsewhere and passed in. Nothing in this module invents
   * them, stores them, or sends them anywhere.
   */
  readonly recoveryWords?: readonly string[];
}

export interface OnboardingStepView {
  readonly id: FirstRunStep;
  readonly ordinal: number;
  readonly heading: string;
  readonly blurb: string;
  readonly done: boolean;
  readonly current: boolean;
  readonly action: ActionView | null;
}

export interface RecoverySheetView {
  readonly heading: string;
  readonly blurb: string;
  /** Shown without being asked for. */
  readonly offered: boolean;
  /** There is a control that moves past it, and moving past it costs nothing. */
  readonly skippable: boolean;
  readonly printable: boolean;
  readonly wordsHeading: string;
  readonly words: readonly string[];
  readonly later: string;
  readonly actions: readonly ActionView[];
}

export interface OnboardingView {
  readonly heading: string;
  readonly lede: string;
  readonly steps: readonly OnboardingStepView[];
  readonly custody: string;
  readonly recovery: RecoverySheetView;
}

const STEP_COPY: Record<FirstRunStep, { heading: string; blurb: string }> = {
  'sign-up': { heading: COPY.firstRun.signUp, blurb: COPY.firstRun.signUpBlurb },
  connect: { heading: COPY.firstRun.connect, blurb: COPY.firstRun.connectBlurb },
  'first-brief': { heading: COPY.firstRun.firstBrief, blurb: COPY.firstRun.firstBriefBlurb },
};

export function buildOnboarding(input: OnboardingInput = {}): OnboardingView {
  const at = input.step ?? 'sign-up';
  const index = FIRST_RUN_STEPS.indexOf(at);
  const words = input.recoveryWords ?? [];

  const steps = FIRST_RUN_STEPS.map((id, i): OnboardingStepView => {
    const current = i === index;
    return {
      id,
      ordinal: i + 1,
      heading: STEP_COPY[id].heading,
      blurb: STEP_COPY[id].blurb,
      done: i < index,
      current,
      // Only the step you are on offers a control. A first run with three live buttons is
      // a form, and a form is a wizard with better manners.
      action: current
        ? {
            id: `first-run:${id}`,
            label: i === FIRST_RUN_STEPS.length - 1 ? COPY.firstRun.done : COPY.firstRun.next,
            primary: true,
            dispatch: { kind: 'first-run', step: id },
          }
        : null,
    };
  });

  return {
    heading: COPY.firstRun.heading,
    lede: COPY.firstRun.lede,
    steps,
    custody: COPY.firstRun.custody,
    recovery: {
      heading: COPY.firstRun.recoveryHeading,
      blurb: COPY.firstRun.recoveryBlurb,
      offered: true,
      skippable: true,
      printable: true,
      wordsHeading: COPY.firstRun.recoveryWords(words.length),
      words,
      later: COPY.firstRun.recoveryLater,
      actions: [
        {
          id: 'first-run:print-recovery',
          label: COPY.firstRun.recoveryPrint,
          primary: true,
          dispatch: { kind: 'first-run', step: 'print-recovery' },
        },
        {
          id: 'first-run:skip-recovery',
          label: COPY.firstRun.recoverySkip,
          primary: false,
          dispatch: { kind: 'first-run', step: 'skip-recovery' },
        },
      ],
    },
  };
}

/**
 * The sheet as something a printer can take: one page, no markup, the words numbered so a
 * person reading them back cannot lose their place.
 */
export function recoverySheetText(view: RecoverySheetView): string {
  const lines = [COPY.appName, view.heading, '', view.blurb, '', view.wordsHeading, ''];
  view.words.forEach((word, i) => lines.push(`${String(i + 1).padStart(2, ' ')}. ${word}`));
  lines.push('', view.later);
  return lines.join('\n');
}

/** Every sentence on the first-run path, for the scanner. */
export function onboardingStrings(view: OnboardingView): string[] {
  return [
    view.heading,
    view.lede,
    view.custody,
    ...view.steps.flatMap((s) => [s.heading, s.blurb, ...(s.action === null ? [] : [s.action.label])]),
    view.recovery.heading,
    view.recovery.blurb,
    view.recovery.wordsHeading,
    view.recovery.later,
    ...view.recovery.actions.map((a) => a.label),
  ];
}
