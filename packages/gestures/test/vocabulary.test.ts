import {
  FORBIDDEN_TERMS,
  scanExclamations,
  scanVocabulary,
  visibleText,
} from '@servanda/client-web';
import { describe, expect, it } from 'vitest';
import {
  MILA,
  allGestureCopyStrings,
  everyCard,
  fixtureDirectory,
  gestureCardEl,
  meetingEndCards,
  meetingFixture,
} from '../src/index.js';

/**
 * The vocabulary law applies to this surface exactly as it applies to the app, and for a
 * sharper reason: a card shown inside somebody else's chat window is read by people who have
 * never signed up for anything. It is the first sentence of the product many of them see.
 */
function everythingAPersonReads(): string[] {
  const read: string[] = [...allGestureCopyStrings()];
  for (const card of [...everyCard(), ...meetingEndCards(meetingFixture(), fixtureDirectory(), MILA)]) {
    read.push(...visibleText(gestureCardEl(card)));
  }
  return read;
}

describe('vocabulary and register', () => {
  it('uses none of the forbidden terms and shouts at nobody', () => {
    const read = everythingAPersonReads();
    expect(read.length).toBeGreaterThan(0);
    expect(scanVocabulary(read)).toEqual([]);
    expect(scanExclamations(read)).toEqual([]);
  });

  it('scans the same terms the app is scanned against', () => {
    expect([...FORBIDDEN_TERMS]).toContain('persona');
    expect([...FORBIDDEN_TERMS]).toContain('edge');
  });

  it('the scanners can fail', () => {
    expect(scanVocabulary(['This edge is proposed'])).toHaveLength(1);
    expect(scanExclamations(['Confirmed!'])).toHaveLength(1);
  });
});
