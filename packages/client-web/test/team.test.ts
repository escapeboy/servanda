import { describe, expect, it } from 'vitest';
import { COPY, appEl, buildTeam, makeTeamFixture, renderToHtml, visibleText } from '../src/index.js';
import { NOW, app } from './fixture.js';

/**
 * The team surface — doctrine surface 6, "the blocking graph as auto-standup; a 40-second
 * read". Its two laws (M-4 visibility, M-11 no scoreboard) have named tests of their own.
 * What is checked here is that it is actually the read it claims to be.
 */
describe('the blocking graph reads as a standup, in about forty seconds', () => {
  const view = buildTeam(makeTeamFixture(NOW), NOW);

  it('leads with what it is, not with who did what', () => {
    expect(view.heading).toBe(COPY.team.heading);
    expect(view.lede).toBe(COPY.team.lede);
  });

  it('answers the three questions every card answers, for each shared promise', () => {
    expect(view.entries.length).toBeGreaterThan(0);
    for (const entry of view.entries) {
      expect(entry.what.length).toBeGreaterThan(0); // what
      expect(entry.between.length).toBeGreaterThan(0); // with whom
      expect(entry.ifNothingHappens.length).toBeGreaterThan(0); // what happens if nothing does
    }
  });

  it('names both sides of a shared promise, each with its evidence (M-12)', () => {
    const entry = view.entries[0];
    expect(entry?.between).toHaveLength(2);
    expect(entry?.betweenLine).toBe(
      COPY.team.between(entry?.between[0]?.display ?? '', entry?.between[1]?.display ?? ''),
    );
    for (const party of entry?.between ?? []) expect(party.trust.label.length).toBeGreaterThan(0);
  });

  it('says what a promise holds up, and never who is holding it up', () => {
    const entry = view.entries[0];
    expect(entry?.blocks).toEqual(['SPRINT-114']);
    expect(entry?.blocksLine).toBe(COPY.team.blocks('SPRINT-114'));
    // The subject of the sentence is the work. No person is its subject anywhere.
    expect(entry?.blocksLine).not.toContain('Stefan');
  });

  it('stays short enough to be read in a standup', async () => {
    // A forty-second read is roughly a hundred and fifty words. The surface is bounded by
    // what was shared, so the check is that the chrome adds almost nothing to it.
    const words = visibleText(appEl(await app('team'))).join(' ').split(/\s+/u).length;
    expect(words).toBeLessThan(150);
  });

  it('says plainly, on the page, that it shows only what was shared', async () => {
    expect(view.note).toBe(COPY.team.note);
    expect(renderToHtml(appEl(await app('team')))).toContain(COPY.team.note);
  });

  it('has an empty state that does not read as an accusation', () => {
    const empty = buildTeam({ scope: { key: 'e'.repeat(64), label: 'Platform' }, publications: [] }, NOW);
    expect(empty.entries).toEqual([]);
    expect(empty.empty).toBe(COPY.team.empty);
  });
});
