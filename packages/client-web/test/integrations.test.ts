import { describe, expect, it } from 'vitest';
import {
  COPY,
  GRADIENT_RUNGS,
  appEl,
  buildIntegrations,
  focusOrder,
  integrationsEl,
  makeIntegrationsFixture,
  renderToHtml,
  rungsFor,
  walk,
} from '../src/index.js';
import { app } from './fixture.js';

/**
 * Integrations & Trust. The doctrine line under test: "Trust sliders are displayed but
 * earned; locked rungs explain what unlocks them" — and, from the permanent exclusions,
 * nothing here may be a control that grants autonomy.
 */
describe('the trust gradient is displayed and never granted', () => {
  const view = buildIntegrations(makeIntegrationsFixture());

  it('shows every rung for every kind of work, in one order', () => {
    expect(view.classes.length).toBeGreaterThan(0);
    for (const workClass of view.classes) {
      expect(workClass.rungs.map((r) => r.rung)).toEqual([...GRADIENT_RUNGS]);
    }
  });

  it('marks what has been earned, where it stands, and what has not', () => {
    const tests = view.classes.find((c) => c.id === 'tests');
    expect(tests?.rungs.map((r) => r.state)).toEqual(['earned', 'standing', 'locked', 'locked']);
  });

  it('explains what would open a locked rung, rather than only locking it', () => {
    for (const workClass of view.classes) {
      for (const rung of workClass.rungs) {
        if (rung.state === 'locked' || rung.state === 'closed') {
          expect(rung.explains).not.toBeNull();
          expect((rung.explains ?? '').length).toBeGreaterThan(0);
        } else {
          expect(rung.explains).toBeNull();
        }
      }
    }
  });

  it('says when a kind of work has a ceiling it never passes', () => {
    const ci = view.classes.find((c) => c.id === 'ci-config');
    expect(ci?.rungs.map((r) => r.state)).toEqual(['standing', 'locked', 'closed', 'closed']);
    expect(ci?.rungs[3]?.explains).toBe(COPY.sources.ceiling(COPY.sources.rungs.draft));
  });

  it('counts up correctly to each further rung', () => {
    const rungs = rungsFor({ id: 'x', label: 'x', standing: 'suggest', toNextRung: 2 });
    expect(rungs[1]?.explains).toBe(COPY.sources.unlock(2));
    expect(rungs[2]?.explains).toBe(COPY.sources.unlock(3));
    expect(rungs[3]?.explains).toBe(COPY.sources.unlock(4));
  });

  it('has no control inside a gradient — not a button, not a focus stop, not anything', async () => {
    const tree = integrationsEl(view);
    // Every node under a `.rungs` list, and none of them acts or focuses.
    const rungNodes = walk(tree).filter((n) => String(n.attrs?.['class'] ?? '').startsWith('rung'));
    expect(rungNodes.length).toBeGreaterThan(0);
    for (const node of rungNodes) {
      expect(node.tag).not.toBe('button');
      expect(node.attrs?.['data-action']).toBeUndefined();
      expect(node.attrs?.['tabindex']).toBeUndefined();
    }
    // And nothing a keyboard reaches on this surface belongs to a gradient.
    const stops = focusOrder(appEl(await app('trust')));
    for (const stop of stops) {
      expect(String(stop.element.attrs?.['class'] ?? '')).not.toContain('rung');
    }
  });

  it('has no way to ask for more leeway than the work has earned', () => {
    // `rungsFor` takes what has been earned as its only input. There is no argument for
    // "grant", no override, and no field a caller could set to move the standing.
    const asked = rungsFor({ id: 'x', label: 'x', standing: 'suggest' } as never);
    expect(asked.filter((r) => r.state === 'earned')).toEqual([]);
    expect(asked[0]?.state).toBe('standing');
  });
});

describe('connected sources are controls, because a source is not a permission', () => {
  const view = buildIntegrations(makeIntegrationsFixture());

  it('lists each source with its state and when it was last read', () => {
    expect(view.sources.map((s) => s.status)).toEqual([
      COPY.sources.connected,
      COPY.sources.connected,
      COPY.sources.notConnected,
    ]);
    expect(view.sources[1]?.lastRead).toBe(COPY.sources.neverRead);
  });

  it('offers connect where disconnected and disconnect where connected', () => {
    expect(view.sources.map((s) => s.action.label)).toEqual([
      COPY.sources.disconnect,
      COPY.sources.disconnect,
      COPY.sources.connect,
    ]);
    expect(view.sources[2]?.action.dispatch).toEqual({
      kind: 'source',
      source: 'calendar',
      op: 'connect',
    });
  });

  it('puts the control before the description, as every card does', () => {
    const html = renderToHtml(integrationsEl(view));
    expect(html.indexOf('card-actions')).toBeLessThan(html.indexOf('class="what"'));
  });
});
