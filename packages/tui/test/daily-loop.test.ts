import { describe, expect, it } from 'vitest';
import type { AppView } from '@servanda/client-web';
import { FixtureNodeClient, loadApp, makeFixture, stopsFor } from '@servanda/client-web';
import { frameLines, handleKey, inkRows } from '../src/index.js';

const NOW = '2026-03-01T09:00:00Z';
/** What a terminal actually sends. Built by code point: an escape byte is invisible in a diff. */
const ESC = String.fromCharCode(27);

async function app(): Promise<AppView> {
  const fixture = makeFixture(6, NOW);
  return loadApp(new FixtureNodeClient(fixture), {
    surface: 'brief',
    now: NOW,
    pending: { items: fixture.pending },
  });
}

/**
 * "Full keyboard operation" (USAGE §4). The key names in `handleKey` are the tokens the Ink
 * layer produces — `[A`, `[B`, `[Z` — and a terminal in raw mode does not send those. It
 * sends them behind an escape byte, which matched nothing.
 */
describe('the keys a terminal actually sends', () => {
  it('walks forward on the down arrow', async () => {
    const state = { app: await app(), cursor: 0, quit: false };
    expect(handleKey(state, `${ESC}[B`).state.cursor).toBe(1);
  });

  it('walks back on the up arrow and on shift-tab', async () => {
    const state = { app: await app(), cursor: 2, quit: false };
    expect(handleKey(state, `${ESC}[A`).state.cursor).toBe(1);
    expect(handleKey(state, `${ESC}[Z`).state.cursor).toBe(1);
  });

  it('leaves a bare escape alone rather than treating it as a movement', async () => {
    const state = { app: await app(), cursor: 2, quit: false };
    const result = handleKey(state, ESC);
    expect(result.state.cursor).toBe(2);
    expect(result.activated).toBeNull();
  });

  it('still answers the tokens the Ink layer hands it', async () => {
    const state = { app: await app(), cursor: 0, quit: false };
    expect(handleKey(state, '[B').state.cursor).toBe(1);
    expect(handleKey(state, '[Z').state.cursor).toBe(stopsFor(state.app).length - 1);
  });
});

/**
 * The demonstration label. `bin/servanda.mjs` printed it once, above the frame, and Ink clears
 * the whole terminal the moment the frame is taller than the window — which any register with
 * a few cards is. The line then never came back, and invented promises looked like a register.
 */
describe('which register you are looking at', () => {
  it('is part of the frame, so every renderer draws it', async () => {
    const banner = 'DEMONSTRATION — these promises are invented.';
    const lines = frameLines({ app: await app(), cursor: 0, banner });
    expect(lines[0]).toBe(banner);
  });

  it('is redrawn on every frame Ink produces, not written once above it', async () => {
    const banner = 'Your register · vault /home/you/.servanda';
    const rows = inkRows({ app: await app(), cursor: 0, banner });
    expect(rows[0]?.text).toBe(banner);
  });

  it('cannot carry an escape sequence out of the environment it was built from', async () => {
    const lines = frameLines({ app: await app(), cursor: 0, banner: `vault ${ESC}[8m/tmp/x` });
    expect(lines[0]).not.toContain(ESC);
  });

  it('omits the line entirely when there is none', async () => {
    const lines = frameLines({ app: await app(), cursor: 0 });
    expect(lines[0]).toBe('Servanda');
  });
});
