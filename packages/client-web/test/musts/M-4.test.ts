import { describe, expect, it } from 'vitest';
import {
  OTHER_SCOPE_KEY,
  TEAM_SCOPE_KEY,
  appEl,
  buildTeam,
  makeTeamFixture,
  renderToHtml,
  sharedWith,
  visibleText,
} from '../../src/index.js';
import type { TeamPublication } from '../../src/index.js';
import { NOW, app } from '../fixture.js';

/**
 * M-4 — "Visibility follows participation (§5.3 a–c). Publishing is an explicit signed act
 * by a party."
 *
 * The team surface is the one place in this layer where the rule can be broken, because it
 * is the only surface that shows a person something that is not theirs. Three failures are
 * possible and all three are tested: showing what nobody shared (M-4b), showing what was
 * shared somewhere else (M-4c), and treating an unset scope as a wildcard — which is the
 * shape the bug actually takes when a filter is written carelessly.
 *
 * The fixture deliberately contains all three kinds of promise, so a surface that stopped
 * filtering would show more, not less, and the test would catch it.
 */
describe('M-4: the team surface shows only what a party chose to share into this team', () => {
  const fixture = makeTeamFixture(NOW);

  it('never shows a promise nobody shared (M-4b: membership grants nothing)', () => {
    const view = buildTeam(fixture, NOW);
    const ids = view.entries.map((e) => e.id);
    // Everyone in the fixture is a member of the same team. Membership is not the question.
    expect(ids).toContain('shared-here');
    expect(ids).not.toContain('never-shared');
  });

  it('never shows a promise shared into a different team (M-4c: no inheritance)', () => {
    const view = buildTeam(fixture, NOW);
    expect(view.entries.map((e) => e.id)).not.toContain('shared-elsewhere');
    expect(sharedWith(TEAM_SCOPE_KEY, fixture.publications).map((p) => p.item.id)).toEqual([
      'shared-here',
    ]);
    expect(sharedWith(OTHER_SCOPE_KEY, fixture.publications).map((p) => p.item.id)).toEqual([
      'shared-elsewhere',
    ]);
  });

  it('reaches nothing an unshared promise says, anywhere on the rendered surface', async () => {
    const view = await app('team');
    const read = visibleText(appEl(view)).join('\n');
    expect(read).toContain('Pull a copy of live data for the repro');
    expect(read).not.toContain('Reply to the recruiter');
    expect(read).not.toContain('Draft the pricing note');
  });

  it('treats an unset team as no team rather than as every team', () => {
    // The failure mode worth naming: an empty filter that quietly matches everything.
    expect(sharedWith('', fixture.publications)).toEqual([]);
    expect(buildTeam({ scope: { key: '', label: '' }, publications: fixture.publications }, NOW).entries).toEqual(
      [],
    );
  });

  it('would show a promise the moment a party shares it, and not before', () => {
    const promise = fixture.publications.find((p) => p.item.id === 'never-shared');
    expect(promise?.shared).toBeNull();
    const nowShared: TeamPublication = {
      ...(promise as TeamPublication),
      shared: { scope: TEAM_SCOPE_KEY, by: 'a'.repeat(64) },
    };
    const before = buildTeam(fixture, NOW).entries.length;
    const after = buildTeam(
      { ...fixture, publications: [...fixture.publications, nowShared] },
      NOW,
    ).entries;
    // The same promise, the same team, the same everything but the signed act.
    expect(after.length).toBe(before + 1);
    expect(after.map((e) => e.id)).toContain('never-shared');
  });

  it('renders the shared promise as a real entry, not as an id in a list', async () => {
    const html = renderToHtml(appEl(await app('team')));
    expect(html).toContain('data-card="shared-here"');
    expect(html).not.toContain('data-card="never-shared"');
    expect(html).not.toContain('data-card="shared-elsewhere"');
  });
});
