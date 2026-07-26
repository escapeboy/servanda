import { describe, expect, it } from 'vitest';
import {
  COPY,
  FIRST_RUN_FORBIDDEN,
  FIRST_RUN_STEPS,
  RECOVERY_WORDS,
  appEl,
  buildOnboarding,
  focusOrder,
  onboardingStrings,
  recoverySheetText,
  scanFirstRun,
  visibleText,
} from '../src/index.js';
import { app } from './fixture.js';

/**
 * First run, against the law it exists to obey: "the default path assumes zero technical
 * vocabulary. Any surface, flow, or sentence that requires knowing what a node, vault, MCP,
 * or ledger *is* has violated this document." And, named explicitly by the doctrine: the
 * word "install" does not exist on this path.
 */
describe('the non-technical path is the default, and is checked rather than intended', () => {
  const view = buildOnboarding({ recoveryWords: RECOVERY_WORDS });

  it('is sign up, connect, first note — three steps, in that order', () => {
    expect(FIRST_RUN_STEPS).toEqual(['sign-up', 'connect', 'first-brief']);
    expect(view.steps.map((s) => s.heading)).toEqual([
      COPY.firstRun.signUp,
      COPY.firstRun.connect,
      COPY.firstRun.firstBrief,
    ]);
    expect(view.steps.map((s) => s.ordinal)).toEqual([1, 2, 3]);
  });

  it('uses no word that assumes the person knows how any of it is built', () => {
    expect(scanFirstRun(onboardingStrings(view))).toEqual([]);
  });

  it('does not contain the word this path forbids by name', () => {
    const read = onboardingStrings(view).join('\n').toLowerCase();
    expect(read).not.toContain('install');
  });

  it('would catch a technical word if one appeared on this path', () => {
    // The scanner has to be able to fail, or the check above proves nothing.
    for (const term of FIRST_RUN_FORBIDDEN) {
      expect(scanFirstRun([`First, ${term} the thing`]).length).toBeGreaterThan(0);
    }
    expect(scanFirstRun(['Install the desktop app']).map((v) => v.term)).toContain('install');
    // And it still enforces everything forbidden everywhere.
    expect(scanFirstRun(['Open the vault']).length).toBeGreaterThan(0);
    expect(scanFirstRun(['Your work email'])).toEqual([]);
  });

  it('offers a control on the step you are on, and on no other', () => {
    for (const at of FIRST_RUN_STEPS) {
      const stepped = buildOnboarding({ step: at });
      expect(stepped.steps.filter((s) => s.action !== null).map((s) => s.id)).toEqual([at]);
      expect(stepped.steps.filter((s) => s.done).length).toBe(FIRST_RUN_STEPS.indexOf(at));
    }
  });

  it('labels custody honestly rather than quietly', () => {
    expect(view.custody).toBe(COPY.firstRun.custody);
    expect(view.custody.length).toBeGreaterThan(0);
  });
});

describe('the recovery sheet is offered, skippable and printable', () => {
  const view = buildOnboarding({ recoveryWords: RECOVERY_WORDS });
  const sheet = view.recovery;

  it('is shown without being asked for', () => {
    expect(sheet.offered).toBe(true);
    expect(sheet.heading).toBe(COPY.firstRun.recoveryHeading);
  });

  it('can be walked past, and says so in words as well as in a control', () => {
    expect(sheet.skippable).toBe(true);
    const skip = sheet.actions.find((a) => a.label === COPY.firstRun.recoverySkip);
    expect(skip).toBeDefined();
    expect(sheet.later).toBe(COPY.firstRun.recoveryLater);
  });

  it('prints to one page a person can keep, with the words numbered', () => {
    expect(sheet.printable).toBe(true);
    const printed = recoverySheetText(sheet);
    expect(printed).toContain(COPY.appName);
    for (const word of RECOVERY_WORDS) expect(printed).toContain(word);
    expect(printed).toContain(' 1. harbour');
    expect(printed).toContain('12. walnut');
  });

  it('invents no words of its own when none were given', () => {
    const bare = buildOnboarding();
    expect(bare.recovery.words).toEqual([]);
    expect(bare.recovery.offered).toBe(true);
    expect(recoverySheetText(bare.recovery)).toContain(COPY.firstRun.recoveryBlurb);
  });

  it('reaches both of its controls from the keyboard, on the rendered surface', async () => {
    const names = focusOrder(appEl(await app('first-run'))).map((s) => s.name);
    expect(names).toContain(COPY.firstRun.recoveryPrint);
    expect(names).toContain(COPY.firstRun.recoverySkip);
  });

  it('shows the words on the surface, so the sheet is not a promise of a sheet', async () => {
    const read = visibleText(appEl(await app('first-run')));
    for (const word of RECOVERY_WORDS) expect(read).toContain(word);
  });
});
