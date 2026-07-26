import { describe, expect, it } from 'vitest';
import { appEl, buildTeam, makeTeamFixture, visibleText, walk } from '../../src/index.js';
import type { TeamEntryView, TeamView } from '../../src/index.js';
import { ALL_SURFACES, NOW, app } from '../fixture.js';

/**
 * M-11 — "No network-level reputation: no cross-party fulfillment statistics computed,
 * stored or served."
 *
 * In this layer M-11 is a rule about pixels, and the doctrine says so: "gamification is
 * reputation through the back door; M-11 applies to pixels." The team surface is where a
 * scoreboard would appear if one ever did, so the test is structural rather than a reading
 * of the copy: the view model is checked for any field that could carry a per-person
 * number, because a statistic that is computed for display has already been computed.
 *
 * "Your standup writes itself", never "see who is behind".
 */

const TEAM_FIELDS = new Set(['heading', 'lede', 'scopeLabel', 'empty', 'note', 'entries']);
const ENTRY_FIELDS = new Set([
  'id',
  'what',
  'between',
  'betweenLine',
  'ifNothingHappens',
  'tone',
  'seal',
  'blocks',
  'blocksLine',
]);

/**
 * Field names a scoreboard cannot be built without. Matched as substrings because view
 * fields are camelCase and `keptOnTimeCount` must be caught as readily as `count`.
 */
const TALLY_FIELD =
  /score|rank|streak|leaderboard|percent|tally|statistic|reliability|completion|ontime|fulfil/iu;

/**
 * Words a scoreboard says out loud. Word-bounded, because "generated" is not "rate"; and
 * "behind" only counts as a verdict when a person is its subject — "the work behind this
 * rung" is a preposition doing an honest day's work.
 */
const TALLY_WORD =
  /\b(scores?|ranked|ranking|streaks?|leaderboard|overdue|failed|missed|badges?|points?)\b|\b(is|are|was|were|falling|fell|running)\s+(behind|late)\b/iu;

describe('M-11: no surface in this layer keeps a score of anybody', () => {
  const view: TeamView = buildTeam(makeTeamFixture(NOW), NOW);

  it('has exactly the fields it was designed with, and no room for a tally', () => {
    expect(new Set(Object.keys(view))).toEqual(TEAM_FIELDS);
    for (const entry of view.entries) {
      expect(new Set(Object.keys(entry))).toEqual(ENTRY_FIELDS);
    }
  });

  it('carries no number attached to a person', () => {
    const numbersUnder = (value: unknown, path: string[] = []): string[] => {
      if (typeof value === 'number') return [path.join('.')];
      if (Array.isArray(value)) return value.flatMap((v, i) => numbersUnder(v, [...path, String(i)]));
      if (value !== null && typeof value === 'object') {
        return Object.entries(value).flatMap(([k, v]) => numbersUnder(v, [...path, k]));
      }
      return [];
    };
    // The only numbers on this surface would be array indices; there is no counted field.
    expect(numbersUnder(view)).toEqual([]);
  });

  it('names no field a scoreboard would need, on any surface', async () => {
    const keysOf = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(keysOf);
      if (value !== null && typeof value === 'object') {
        return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
      }
      return [];
    };
    for (const surface of ALL_SURFACES) {
      const offending = [...new Set(keysOf(await app(surface)))].filter((k) => TALLY_FIELD.test(k));
      expect(offending).toEqual([]);
    }
  });

  it('says nothing about a person that a scoreboard would say', async () => {
    for (const surface of ALL_SURFACES) {
      for (const text of visibleText(appEl(await app(surface)))) {
        expect(text).not.toMatch(TALLY_WORD);
      }
    }
  });

  it('offers no control that would order people against each other', async () => {
    const view = await app('team');
    // No sort, no filter, no column header: the team surface has no control at all, and
    // any ordering keyed on who owes what is a ranking of people in a different hat.
    const controls = walk(appEl(view)).filter(
      (n) => typeof n.attrs?.['data-action'] === 'string' && n.attrs['data-action'] !== '',
    );
    expect(controls).toEqual([]);
  });

  it('would catch a tally if one were added to an entry', () => {
    // The check has to be able to fail. This is what a per-person statistic looks like.
    const smuggled = { ...(view.entries[0] as TeamEntryView), keptOnTime: 4 } as unknown as Record<
      string,
      unknown
    >;
    expect(new Set(Object.keys(smuggled))).not.toEqual(ENTRY_FIELDS);
    expect(TALLY_FIELD.test('completionRate')).toBe(true);
    expect(TALLY_FIELD.test('keptOnTimeCount')).toBe(true);
    expect(TALLY_WORD.test('Mila is behind')).toBe(true);
    expect(TALLY_WORD.test('As of 2026-03-01T09:00:00Z.')).toBe(false);
  });
});
