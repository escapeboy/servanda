import { describe, expect, it } from 'vitest';
import { ServandaNode } from '../src/node.js';
import { makeFixture, syncEdge, type Fixture } from './support/fixture.js';

/**
 * §7 `brief` — what the attention market puts above the line.
 *
 * `open_loops` and `brief` read the same vault, so they must not disagree about what is in it.
 * `open_loops` surfaces a proposed commitment ONCE, as its edge; `brief` ranks the vault's
 * ordering keys, and the vault emits a key for the commitment AND a key for the edge that was
 * built from it. Nothing deduplicated them.
 */
describe('brief: one item, one slot', () => {
  it('surfaces a proposed commitment once, as its edge', () => {
    const fx: Fixture = makeFixture();
    const out = fx.node.commit({
      intent: 'the only thing in this vault',
      owed_to: fx.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    });

    const brief = fx.node.brief({ persona: fx.personas[0]! });
    const ids = brief.slots.map((s) => s.item_id);

    // Two slots for one promise: the edge, and the commitment it was built from. The second one
    // offers `propose` — an act on a record that has already been proposed, which is M-20's first
    // rule read backwards.
    expect(ids).toEqual([out.edge_id]);
    expect(brief.slots.map((s) => s.primary_action?.act)).not.toContain('propose');

    fx.cleanup();
  });

  /**
   * A vault-local commitment has no edge, so `propose` is genuinely the act. It must still be
   * there — the dedupe is "an edge supersedes its commitment", not "commitments are hidden".
   */
  it('still surfaces a commitment that has no edge', () => {
    const fx: Fixture = makeFixture();
    fx.node.commit({ intent: 'nobody else is involved', owed_to: null, due: null, persona: null, propose: false });

    const brief = fx.node.brief({ persona: fx.personas[0]! });
    expect(brief.slots).toHaveLength(1);
    expect(brief.slots[0]!.primary_action).toEqual({ act: 'propose', tool: null, args: {} });

    fx.cleanup();
  });

  /**
   * The counterparty's side. They hold the edge and never the plaintext (M-7), so their brief has
   * exactly one key for it and the dedupe must not remove that.
   */
  it('surfaces the counterparty’s edge, which has no commitment behind it', () => {
    const fx: Fixture = makeFixture();
    const edgeId = fx.node.commit({
      intent: 'their side of it',
      owed_to: fx.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    }).edge_id!;
    syncEdge(fx, 0, 1, edgeId);

    const theirs = new ServandaNode({
      vault: fx.vault,
      activePersona: fx.personas[1]!,
      now: () => fx.now,
    });
    const brief = theirs.brief({ persona: fx.personas[1]! });
    expect(brief.slots.map((s) => s.item_id)).toEqual([edgeId]);

    fx.cleanup();
  });

  it('agrees with open_loops about how many things are in the vault', () => {
    const fx: Fixture = makeFixture();
    fx.node.commit({ intent: 'proposed one', owed_to: fx.personas[1]!, due: null, persona: null, propose: true });
    fx.node.commit({ intent: 'vault-local one', owed_to: null, due: null, persona: null, propose: false });
    fx.node.expect({ expect: 'their draft', from: 'them', context: null });

    const loops = fx.node.openLoops({ view: 'all', persona: fx.personas[0]!, limit: 50 });
    const brief = fx.node.brief({ persona: fx.personas[0]! });

    expect(brief.slots.length + brief.below_the_line_count).toBe(loops.items.length);

    fx.cleanup();
  });
});
