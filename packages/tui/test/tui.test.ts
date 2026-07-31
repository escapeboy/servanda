import { describe, expect, it } from 'vitest';
import type { AppView, SurfaceId } from '@servanda/client-web';
import {
  COPY,
  FixtureNodeClient,
  RECOVERY_WORDS,
  appEl,
  focusOrder,
  loadApp,
  makeFixture,
  makeIntegrationsFixture,
  makeProofFixture,
  makeTeamFixture,
  scanAll,
  stopsFor,
  visibleText,
} from '@servanda/client-web';
import { dispatch, frame, frameLines, handleKey } from '../src/index.js';

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
    proof: makeProofFixture({ plaintext: 'the words of the promise', viewer: 'owner' }),
  });
}

const surfaces: SurfaceId[] = [
  'brief',
  'owe',
  'waiting',
  'closed',
  'inbox',
  'team',
  'trust',
  'first-run',
  'proof',
];

describe('the terminal is the same surface, in text', () => {
  it('walks exactly the stops the browser walks', async () => {
    for (const surface of surfaces) {
      const view = await app(surface);
      const browser = focusOrder(appEl(view)).map((s) => s.name);
      const shared = stopsFor(view).map((s) => s.label);
      expect(browser).toEqual(shared);
    }
  });

  it('says the same things the browser says', async () => {
    for (const surface of surfaces) {
      const view = await app(surface);
      const text = frame({ app: view, cursor: 0 });
      for (const line of visibleText(appEl(view))) {
        expect(text).toContain(line);
      }
    }
  });

  it('leads every card with its primary action, as the browser does', async () => {
    const view = await app('owe');
    const lines = frameLines({ app: view, cursor: 0 });
    const card = view.ledger.sections.find((s) => s.id === 'owe')?.cards[0];
    const actionsLine = lines.find((l) => l.includes(`[${card?.actions[0]?.label ?? ''}]`)) ?? '';
    const whatIndex = lines.indexOf(card?.what ?? '');
    expect(lines.indexOf(actionsLine)).toBeLessThan(whatIndex);
  });

  it('shows every name with the evidence behind it (M-12)', async () => {
    const view = await app('owe');
    const text = frame({ app: view, cursor: 0 });
    for (const card of view.ledger.sections.find((s) => s.id === 'owe')?.cards ?? []) {
      if (card.withWhom === null) continue;
      expect(text).toContain(`${card.withWhom.display} · ${card.withWhom.trust.label}`);
    }
  });

  it('speaks no machinery vocabulary and raises its voice at nobody', async () => {
    for (const surface of surfaces) {
      const view = await app(surface);
      expect(scanAll(frameLines({ app: view, cursor: 0 }))).toEqual([]);
    }
  });
});

describe('the terminal is operable by keys alone', () => {
  it('moves the cursor forward and back over every stop', async () => {
    const view = await app('owe');
    const stops = stopsFor(view);
    let state = { app: view, cursor: 0, quit: false };
    const seen = new Set<number>();
    for (let i = 0; i < stops.length; i++) {
      seen.add(state.cursor);
      state = handleKey(state, '\t').state;
    }
    expect(state.cursor).toBe(0);
    expect(seen.size).toBe(stops.length);

    state = handleKey(state, 'k').state;
    expect(state.cursor).toBe(stops.length - 1);
  });

  it('activates the focused stop with Enter and with Space', async () => {
    const view = await app('inbox');
    const stops = stopsFor(view);
    const first = stops.findIndex((s) => s.kind === 'action');
    expect(first).toBeGreaterThan(-1);
    for (const key of ['\r', ' ']) {
      const result = handleKey({ app: view, cursor: first, quit: false }, key);
      expect(result.activated).toBe(stops[first]?.id);
    }
  });

  it('switches surfaces by number and by activating a navigation stop', async () => {
    const view = await app('brief');
    expect(handleKey({ app: view, cursor: 0, quit: false }, '3').surface).toBe('waiting');
    expect(handleKey({ app: view, cursor: 4, quit: false }, '\r').surface).toBe('inbox');
  });

  it('does nothing for a key that means nothing', async () => {
    const view = await app('brief');
    const result = handleKey({ app: view, cursor: 2, quit: false }, 'z');
    expect(result).toEqual({ state: { app: view, cursor: 2, quit: false }, activated: null, surface: null });
  });

  it('quits on q and on the interrupt', async () => {
    const view = await app('brief');
    expect(handleKey({ app: view, cursor: 0, quit: false }, 'q').state.quit).toBe(true);
    expect(handleKey({ app: view, cursor: 0, quit: false }, String.fromCharCode(3)).state.quit).toBe(true);
  });
});

describe('the terminal reaches the register through the same six tools', () => {
  it('confirms through §7 confirm', async () => {
    const fixture = makeFixture(6, NOW);
    const client = new FixtureNodeClient(fixture);
    const view = await loadApp(client, {
      surface: 'inbox',
      now: NOW,
      pending: { items: fixture.pending },
    });
    const actionId = view.inbox.cards[0]?.actions[0]?.id ?? '';
    expect(await dispatch(client, view, actionId)).toBe('confirmed');
    expect(client.confirmed).toEqual([{ id: 'pending-0', decision: 'confirm' }]);
  });

  it('reports an act v0 binds to no tool rather than inventing one', async () => {
    // This used to assert `done` was unmapped, which was true while §7 named a tool for none of
    // its five actions. `done` reaches the `act` tool now (upstream #19), so the case that still
    // exercises the rule is one of the acts v0 genuinely leaves unbound.
    const fixture = makeFixture(6, NOW);
    const client = new FixtureNodeClient(fixture);
    const view = await loadApp(client, { surface: 'owe', now: NOW });
    const card = view.ledger.sections.find((s) => s.id === 'owe')?.cards[0];
    const delegate = card?.actions.find((a) => a.label === COPY.actions.delegate);
    expect(await dispatch(client, view, delegate?.id ?? '')).toBe('unmapped');
    expect(client.confirmed).toEqual([]);
  });
});
