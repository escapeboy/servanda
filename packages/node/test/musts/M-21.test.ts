import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BriefSlot, ItemAction } from '@servanda/types';
import { actionsFor, type ViewerRole } from '../../src/actions.js';
import { makeFixture, type Fixture } from '../support/fixture.js';

/**
 * M-21 — no user-facing copy crosses the node surface.
 *
 * The node half is checkable and checked here: an advertised affordance carries `{act, tool, args}`
 * and nothing that reads as wording. `primary_action.label` used to carry a string a client would
 * paint, which is what upstream #20 was raised about.
 *
 * The client half — "a client MUST author the wording of every affordance it renders" — is a prose
 * obligation the vectors cannot reach, because a vector pins what a node emits and cannot inspect
 * what a client paints. §8 says so explicitly. Gate GE's vocabulary scan is the nearest thing this
 * repository has to enforcing it.
 *
 * The eleven `actions.json` cases are replayed against `actionsFor` directly: no vault, no clock,
 * so a mismatch is a rule mismatch and not a fixture artefact.
 */
const VECTORS = 'vendor/vectors/node-surface/actions.json';

interface ActionCase {
  name: string;
  edge: { edge_id: string; owner: string; owed_to: string };
  viewer: { role: string };
  effective_state: string;
  window_elapsed: boolean;
  expected_actions: unknown[];
  must_not_advertise: string[];
}

let cases: ActionCase[];

beforeAll(() => {
  cases = JSON.parse(readFileSync(VECTORS, 'utf8')).cases;
});

describe('M-21: the node surface carries acts, never copy', () => {
  it('replays every case the oracle states', () => {
    expect(cases).toHaveLength(11);
  });

  it('emits exactly the advertised actions, for every state and viewer', () => {
    for (const c of cases) {
      const got = actionsFor({
        state: c.effective_state as never,
        role: c.viewer.role as ViewerRole,
        edgeId: c.edge.edge_id,
        windowElapsed: c.window_elapsed,
      });
      expect(got, c.name).toEqual(c.expected_actions);
    }
  });

  it('advertises none of the acts the oracle forbids for that item and viewer', () => {
    // The complement, asserted separately. Equality above would catch it, but this states the
    // M-20/M-21 violation in the terms the spec uses, so a failure names the rule broken.
    for (const c of cases) {
      const got = actionsFor({
        state: c.effective_state as never,
        role: c.viewer.role as ViewerRole,
        edgeId: c.edge.edge_id,
        windowElapsed: c.window_elapsed,
      }).map((a) => a.act);
      for (const forbidden of c.must_not_advertise) {
        expect(got, `${c.name} must not advertise ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('no advertised action carries a copy-bearing member', () => {
    // The positive form of "there is no label". Any key beyond the three the schema names would
    // be a channel for wording to cross the surface.
    for (const c of cases) {
      for (const a of actionsFor({
        state: c.effective_state as never,
        role: c.viewer.role as ViewerRole,
        edgeId: c.edge.edge_id,
        windowElapsed: c.window_elapsed,
      })) {
        expect(Object.keys(a).sort()).toEqual(['act', 'args', 'tool']);
        expect(ItemAction.parse(a)).toBeTruthy();
      }
    }
  });

  it('an act bound to no tool says so rather than naming one that signs nothing', () => {
    const unbound = cases
      .flatMap((c) =>
        actionsFor({
          state: c.effective_state as never,
          role: c.viewer.role as ViewerRole,
          edgeId: c.edge.edge_id,
          windowElapsed: c.window_elapsed,
        }),
      )
      .filter((a) => a.tool === null);
    expect(unbound.length).toBeGreaterThan(0);
    // An unbound act carries no arguments: there is no call to make.
    for (const a of unbound) expect(a.args).toEqual({});
  });

  it('a brief slot rejects a label, and accepts the typed act', () => {
    const item_id = 'a'.repeat(64);
    expect(() =>
      BriefSlot.parse({
        headline: 'wording that arrived over a connection',
        item_id,
        primary_action: { label: 'Mark done', tool: 'act', args: {} },
      }),
    ).toThrow();

    const ok = BriefSlot.parse({
      headline: 'the intent, as the person wrote it',
      item_id,
      primary_action: { act: 'done', tool: 'act', args: { id: item_id, act: 'done' } },
    });
    expect(ok.primary_action).toEqual({ act: 'done', tool: 'act', args: { id: item_id, act: 'done' } });
  });

  it('a real brief from a real vault carries no copy in its actions', () => {
    const fx: Fixture = makeFixture();
    fx.node.commit({
      intent: 'something to appear in the brief',
      owed_to: fx.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    });

    for (const slot of fx.node.brief({ persona: null }).slots) {
      if (slot.primary_action === null) continue;
      expect(Object.keys(slot.primary_action).sort()).toEqual(['act', 'args', 'tool']);
    }

    fx.cleanup();
  });
});
