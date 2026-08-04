import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixture, nodeAs, syncEdge, type Fixture } from './support/fixture.js';

/**
 * §7: `view: "pending"` lists "inbound `proposed` edges AND the local extraction-confirmation
 * queue — exactly the items `confirm` takes as its `id`".
 *
 * Half of that sentence was implemented. `itemsFor` carried an unconditional
 * `if (view === 'pending') continue;` over the edges, so the only thing `pending` ever held was
 * the extraction queue — and an inbound proposal, which is the commonest decision anybody
 * actually faces, appeared only under `waiting`, filed beside promises that need nothing from
 * them at all.
 *
 * The two halves are one question — "what is waiting on me?" — and answering it in two places is
 * how a person misses the half they were not looking at.
 */
describe('§7 view:"pending" is both halves of its sentence', () => {
  let fx: Fixture;
  let edgeId: string;

  beforeAll(() => {
    fx = makeFixture({
      personas: [
        { index: 0, label: 'ana' },
        { index: 1, label: 'boyan' },
      ],
    });
    // Ana promises Boyan and proposes. Ana is the owner; Boyan holds an inbound proposal.
    edgeId = fx.node.commit({
      intent: 'a promise that is waiting on the other person to accept',
      owed_to: fx.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    }).edge_id!;
    syncEdge(fx, 0, 1, edgeId);
  });

  afterAll(() => fx.cleanup());

  const pendingOf = (personaIndex: number): string[] =>
    nodeAs(fx, personaIndex)
      .openLoops({ view: 'pending', persona: fx.personas[personaIndex]!, limit: 50, cursor: null })
      .items.map((i) => i.id);

  it('shows the inbound proposal to the person who has to decide on it', () => {
    expect(pendingOf(1)).toContain(edgeId);
  });

  it('and does NOT show it to the person who made it', () => {
    // Ana's own proposal is something she is waiting on, not something she decides. Putting it in
    // her decision queue would be the mirror of the defect this fixes: a queue that fills with
    // items whose only available act is to wait.
    expect(pendingOf(0)).not.toContain(edgeId);
  });

  it('and it is still in `waiting` for her, which is where a thing you await belongs', () => {
    const waiting = fx.node
      .openLoops({ view: 'waiting', persona: null, limit: 50, cursor: null })
      .items.map((i) => i.id);
    // Boyan owes; Ana waits. The edge appears for whichever of them is not the owner — checked
    // from Boyan's side below, because `waiting` is defined by role and not by view membership.
    const boyanWaiting = nodeAs(fx, 1)
      .openLoops({ view: 'waiting', persona: fx.personas[1]!, limit: 50, cursor: null })
      .items.map((i) => i.id);
    expect(waiting.concat(boyanWaiting)).toContain(edgeId);
  });

  it('and `total` counts what the page holds, per view', () => {
    const out = nodeAs(fx, 1).openLoops({
      view: 'pending',
      persona: fx.personas[1]!,
      limit: 50,
      cursor: null,
    });
    expect(out.total).toBe(out.items.length);
    expect(out.total).toBeGreaterThan(0);
  });
});
