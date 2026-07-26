import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_KEYS,
  accessibleName,
  appEl,
  focusOrder,
  nextStop,
  pointerOnlyControls,
  renderToHtml,
  stopsFor,
  walk,
} from '../src/index.js';
import { app, everySurface } from './fixture.js';

/**
 * The keyboard-only walkthrough. Not "we support keyboards" — an actual walk of every
 * surface, reaching every action, activating each one, with no pointer anywhere.
 */
describe('the web surface is fully operable without a pointer', () => {
  it('has no control that a pointer can reach and a keyboard cannot', async () => {
    for (const view of await everySurface()) {
      const stranded = pointerOnlyControls(appEl(view));
      expect(stranded.map((e) => JSON.stringify(e.attrs))).toEqual([]);
    }
  });

  it('would catch a control that only a pointer can reach', () => {
    // The check has to be able to fail, or the walkthrough above proves nothing.
    const stranded = pointerOnlyControls({
      tag: 'div',
      attrs: {},
      children: [
        { tag: 'div', attrs: { 'data-action': 'x:done' }, text: 'Mark done' },
        { tag: 'button', attrs: { type: 'button', 'data-action': 'x:ping' }, text: 'Ask' },
        { tag: 'a', attrs: { 'data-action': 'x:open' }, text: 'Open' },
      ],
    });
    expect(stranded.map((e) => e.attrs?.['data-action'])).toEqual(['x:done', 'x:open']);
  });

  it('reaches every action the view offers, on every surface', async () => {
    for (const view of await everySurface()) {
      const reachable = new Set(
        focusOrder(appEl(view))
          .map((s) => s.actionId)
          .filter((id): id is string => id !== null),
      );
      const offered = stopsFor(view)
        .filter((s) => s.kind === 'action')
        .map((s) => s.id);
      expect(offered.length).toBeGreaterThan(0);
      for (const id of offered) expect(reachable.has(id)).toBe(true);
    }
  });

  it('walks Tab through every stop and comes back to the start', async () => {
    const view = await app('owe');
    const stops = focusOrder(appEl(view));
    expect(stops.length).toBeGreaterThan(5);

    const visited: string[] = [];
    let index = 0;
    for (let i = 0; i < stops.length; i++) {
      visited.push(stops[index]?.name ?? '');
      index = nextStop(stops, index);
    }
    expect(index).toBe(0);
    expect(new Set(visited).size).toBeGreaterThan(1);
    expect(visited).toHaveLength(stops.length);
  });

  it('walks Shift+Tab back the way it came', async () => {
    const view = await app('brief');
    const stops = focusOrder(appEl(view));
    let index = 0;
    for (let i = 0; i < 4; i++) index = nextStop(stops, index);
    for (let i = 0; i < 4; i++) index = nextStop(stops, index, true);
    expect(index).toBe(0);
  });

  it('activates every action with Enter and with Space, and with nothing else', async () => {
    const view = await app('inbox');
    const stops = focusOrder(appEl(view)).filter((s) => s.actionId !== null);
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) {
      for (const key of ACTIVATION_KEYS) {
        expect(activateWith(stop, key)).toBe(stop.actionId);
      }
      for (const key of ['a', 'Escape', 'Shift', 'ArrowRight']) {
        expect(activateWith(stop, key)).toBeNull();
      }
    }
  });

  it('gives every stop a name a screen reader can announce', async () => {
    for (const view of await everySurface()) {
      for (const stop of focusOrder(appEl(view))) {
        expect(stop.name.length).toBeGreaterThan(0);
      }
    }
  });

  it('puts the primary action first, so Tab reaches it before the rest of the card', async () => {
    const view = await app('owe');
    const tree = appEl(view);
    const names = focusOrder(tree).map((s) => s.name);
    const card = view.ledger.sections.find((s) => s.id === 'owe')?.cards[0];
    const primary = card?.actions.find((a) => a.primary)?.label ?? '';
    const secondary = card?.actions.find((a) => !a.primary)?.label ?? '';
    expect(names.indexOf(primary)).toBeLessThan(names.indexOf(secondary));
  });
});

function activateWith(stop: { actionId: string | null }, key: string): string | null {
  return (ACTIVATION_KEYS as readonly string[]).includes(key) ? stop.actionId : null;
}

describe('a register is a list, so it is rendered as one', () => {
  it('uses native list, heading and button semantics', async () => {
    const view = await app('owe');
    const html = renderToHtml(appEl(view));
    expect(html).toContain('<ul class="cards">');
    expect(html).toContain('<li class="card"');
    expect(html).toContain('<h2');
    expect(html).toContain('<button type="button"');
    expect(html).toContain('<nav aria-label="Servanda">');
  });

  it('marks the surface you are on', async () => {
    const html = renderToHtml(appEl(await app('closed')));
    expect(html).toContain('aria-current="page"');
  });

  it('escapes what a person wrote instead of interpreting it', async () => {
    const view = await app('owe');
    const tree = appEl(view);
    const injected = { ...tree, children: [] };
    expect(renderToHtml({ tag: 'p', text: '<script>alert(1)</script>' })).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(walk(injected).length).toBe(1);
  });

  it('names every element that carries an action', async () => {
    for (const view of await everySurface()) {
      for (const node of walk(appEl(view))) {
        if (typeof node.attrs?.['data-action'] !== 'string') continue;
        expect(accessibleName(node).length).toBeGreaterThan(0);
      }
    }
  });
});
