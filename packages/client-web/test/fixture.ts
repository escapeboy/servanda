import type { AppView, SurfaceId } from '../src/index.js';
import { FixtureNodeClient, loadApp, makeFixture } from '../src/index.js';

/** One instant, one fixture, everywhere. A surface that renders differently by the hour cannot be tested. */
export const NOW = '2026-03-01T09:00:00Z';

export async function app(surface: SurfaceId = 'brief', size = 24): Promise<AppView> {
  const fixture = makeFixture(size, NOW);
  const client = new FixtureNodeClient(fixture);
  return loadApp(client, { surface, now: NOW, pending: { items: fixture.pending } });
}

export async function everySurface(): Promise<AppView[]> {
  const surfaces: SurfaceId[] = ['brief', 'owe', 'waiting', 'closed', 'inbox'];
  return Promise.all(surfaces.map((s) => app(s)));
}
