import type { AppView, SurfaceId } from '../src/index.js';
import {
  FixtureNodeClient,
  RECOVERY_WORDS,
  loadApp,
  makeFixture,
  makeIntegrationsFixture,
  makeProofFixture,
  makeTeamFixture,
} from '../src/index.js';

/** One instant, one fixture, everywhere. A surface that renders differently by the hour cannot be tested. */
export const NOW = '2026-03-01T09:00:00Z';

export async function app(surface: SurfaceId = 'brief', size = 24): Promise<AppView> {
  const fixture = makeFixture(size, NOW);
  const client = new FixtureNodeClient(fixture);
  return loadApp(client, {
    surface,
    now: NOW,
    pending: { items: fixture.pending },
    team: makeTeamFixture(NOW),
    integrations: makeIntegrationsFixture(),
    onboarding: { recoveryWords: RECOVERY_WORDS },
    // In the app, a proof page is being read by one of its two parties, and the words are
    // still on this machine — so the consent control is present and has to be reachable.
    // The public, plaintext-gone case is the M-15 test's business.
    proof: makeProofFixture({ plaintext: PROOF_WORDS, viewer: 'owner' }),
  });
}

/** The words behind the fixture promise. Never rendered: consent defaults to withheld. */
export const PROOF_WORDS = 'Migrate Acme to the new billing provider by 30 September';

/** The five views of the register that existed before the product surfaces were added. */
export const REGISTER_SURFACES: SurfaceId[] = ['brief', 'owe', 'waiting', 'closed', 'inbox'];

/** The four added in this stream: team, trust, first run and the proof page. */
export const PRODUCT_SURFACES: SurfaceId[] = ['team', 'trust', 'first-run', 'proof'];

export const ALL_SURFACES: SurfaceId[] = [...REGISTER_SURFACES, ...PRODUCT_SURFACES];

export async function everySurface(): Promise<AppView[]> {
  return Promise.all(REGISTER_SURFACES.map((s) => app(s)));
}

/** Every surface a person can be shown, old and new. What the gate scans and walks. */
export async function everyViewAnywhere(): Promise<AppView[]> {
  return Promise.all(ALL_SURFACES.map((s) => app(s)));
}
