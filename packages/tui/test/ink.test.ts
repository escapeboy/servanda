import { describe, expect, it } from 'vitest';
import type { AppView, SurfaceId } from '@servanda/client-web';
import {
  FixtureNodeClient,
  RECOVERY_WORDS,
  loadApp,
  makeFixture,
  makeIntegrationsFixture,
  makeProofFixture,
  makeTeamFixture,
  scanAll,
} from '@servanda/client-web';
import { CURSOR_MARKER, frameLines, inkAvailable, inkRows, loadOptional } from '../src/index.js';

const NOW = '2026-03-01T09:00:00Z';

async function app(surface: SurfaceId = 'brief'): Promise<AppView> {
  const fixture = makeFixture(24, NOW);
  const client = new FixtureNodeClient(fixture);
  return loadApp(client, {
    surface,
    now: NOW,
    pending: { items: fixture.pending },
    team: makeTeamFixture(NOW),
    integrations: makeIntegrationsFixture(),
    onboarding: { recoveryWords: RECOVERY_WORDS },
    proof: makeProofFixture(),
  });
}

/**
 * Ink is a wrapper, not a second renderer. The contract below is the whole of what the
 * component layer is allowed to know: rows, in order, exactly as `frameLines` produced
 * them. If it ever needed more than this, the terminal would have two renderers.
 */
describe('the Ink layer wraps the text renderer and adds nothing to it', () => {
  it('emits exactly the lines the text renderer emits, in order', async () => {
    for (const surface of ['brief', 'owe', 'inbox', 'team', 'trust'] as SurfaceId[]) {
      const state = { app: await app(surface), cursor: 0 };
      expect(inkRows(state).map((r) => r.text)).toEqual(frameLines(state));
    }
  });

  it('takes focus from the marker the text renderer already wrote', async () => {
    const state = { app: await app('owe'), cursor: 0 };
    const focused = inkRows(state).filter((r) => r.focused);
    expect(focused.length).toBeGreaterThan(0);
    for (const row of focused) expect(row.text).toContain(CURSOR_MARKER);
    // Moving the cursor moves which rows are marked, and nothing else about them.
    const moved = { ...state, cursor: 6 };
    expect(inkRows(moved).map((r) => r.text)).toEqual(frameLines(moved));
    expect(inkRows(moved).map((r) => r.focused)).not.toEqual(inkRows(state).map((r) => r.focused));
  });

  it('gives every row a stable key', async () => {
    const rows = inkRows({ app: await app('brief'), cursor: 0 });
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('says nothing the other surfaces do not say', async () => {
    for (const surface of ['brief', 'team', 'trust'] as SurfaceId[]) {
      expect(scanAll(inkRows({ app: await app(surface), cursor: 0 }).map((r) => r.text))).toEqual([]);
    }
  });
});

/**
 * The honest half. `ink` and `react` are declared in this package's manifest and are NOT
 * installed in this workspace, so `loadInk()` returns null and the plain-text path runs.
 * Rather than assert today's absence — which would start failing the moment the packages
 * arrive — these tests prove the fallback mechanism itself works, either way.
 */
describe('the rich renderer is optional, and its absence is handled rather than hidden', () => {
  it('answers null for a package that is not there, instead of throwing', async () => {
    expect(await loadOptional('a-package-that-is-not-installed-anywhere')).toBeNull();
  });

  it('still loads a package that is there', async () => {
    expect(await loadOptional('node:path')).not.toBeNull();
  });

  it('reports availability as a fact rather than assuming it', async () => {
    const available = await inkAvailable();
    expect(typeof available).toBe('boolean');
    // Whatever the answer, the text renderer is the one that has to keep working.
    expect(frameLines({ app: await app('brief'), cursor: 0 }).length).toBeGreaterThan(0);
  });
});
