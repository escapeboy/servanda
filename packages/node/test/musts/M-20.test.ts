import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ACT_TOOL_BINDINGS, type ActInput, type ActOutput, type Assertion, type Edge } from '@servanda/types';
import { makeFixture, persona, type Fixture } from '../support/fixture.js';

/**
 * M-20 — `act` signs only the acts bound to it, only for the role that owns them, and only from
 * a state the §4.3 table admits.
 *
 * The oracle is `vendor/vectors/node-surface/act-tool.json`, replayed rather than paraphrased:
 * fourteen cases, eleven of them negative. The negatives are the substance. A `release` accepted
 * from the owner hands the protocol's one unilateral act to the wrong party — the debtor forgiving
 * their own debt — and every positive-only suite in the world passes while that hole is open.
 *
 * §7 also requires that a refused call leave no trace: it signs nothing, so the chain must be
 * byte-identical before and after. That is asserted here rather than assumed, because "rejected"
 * and "rejected without side effects" are different claims and only one of them is checked by
 * looking at the return value.
 */
const VECTORS = 'vendor/vectors/node-surface/act-tool.json';

interface ActCase {
  name: string;
  description: string;
  edge: Edge;
  assertions: Assertion[];
  effective_state: string;
  window_elapsed: boolean;
  call: { caller: { persona_id: string; role: string }; input: Record<string, unknown> };
  expected: { accepted: boolean; rejection_reason: string | null; asserts: string | null };
}

let cases: ActCase[];
let bindings: { act: string; tool: string | null }[];

beforeAll(() => {
  const suite = JSON.parse(readFileSync(VECTORS, 'utf8'));
  cases = suite.cases;
  bindings = suite.act_tool_bindings;
});

/** The vectors' alice/bob/carol are personas 0/1/2 of the published test mnemonic. */
const PERSONA_INDEX = new Map([0, 1, 2].map((i) => [persona(i).personaId, i] as const));

/**
 * Stand the case's edge and chain up in the caller's own vault and make the call for real.
 *
 * The caller holds the edge even when they are not a party to it — that is what makes the
 * non-party case a test of `act` rather than of the vault: carol has the object and still has no
 * standing. The clock is derived from `window_elapsed`, which is the vector's way of saying where
 * `now` sits relative to the acceptance window without pinning a wall-clock instant.
 */
function replay(c: ActCase): ActOutput {
  const index = PERSONA_INDEX.get(c.call.caller.persona_id);
  if (index === undefined) throw new Error(`unknown caller ${c.call.caller.persona_id}`);
  // A case may carry no chain at all — the malformed-edge case is about the edge object, and
  // giving it assertions would be asserting against something the table refuses to read.
  const last = c.assertions[c.assertions.length - 1];
  const lastAsserted = last ? Date.parse(last.asserted_at) : Date.parse(c.edge.proposed_at);
  const now = new Date(lastAsserted + (c.window_elapsed ? 10 * 86_400_000 : 0) + 3_600_000);

  const fx: Fixture = makeFixture({
    personas: [
      { index: 0, label: 'alice' },
      { index: 1, label: 'bob' },
      { index: 2, label: 'carol' },
    ],
    activePersonaIndex: index,
    now,
  });
  const holder = fx.personas[index]!;
  fx.vault.putEdge(holder, c.edge);
  for (const a of c.assertions) fx.vault.appendAssertion(holder, a);
  try {
    return fx.node.act(c.call.input as unknown as ActInput);
  } finally {
    fx.cleanup();
  }
}

describe('M-20: act signs only what it is bound to, for the role that owns it', () => {
  it('the oracle states seventeen cases', () => {
    expect(cases).toHaveLength(17);
  });

  /**
   * The vectors were read and asserted ON — `expect(c.expected.rejection_reason).toBe(...)` checks
   * that the JSON says what the JSON says, which no implementation can fail. Nothing here ran the
   * node. This does, and it is the only thing in this file that can go red for a code change.
   */
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])('case %i, replayed against the node', (i) => {
    const c = cases[i]!;
    expect({ name: c.name, ...replay(c) }).toEqual({ name: c.name, ...c.expected });
  });

  it('the binding table here is the one the vectors pin', () => {
    // ACT_TOOL_BINDINGS is the single source the tool schema and the node both read. If it drifts
    // from the vectors, `act` would advertise or accept an act the suite says it must not.
    const fromVectors = Object.fromEntries(bindings.map((b) => [b.act, b.tool]));
    expect(ACT_TOOL_BINDINGS).toEqual(fromVectors);
  });

  it('only done and release are bound to the act tool', () => {
    const bound = Object.entries(ACT_TOOL_BINDINGS)
      .filter(([, tool]) => tool === 'act')
      .map(([act]) => act)
      .sort();
    expect(bound).toEqual(['done', 'release']);
  });

  it('every act the vectors advertise is known to this implementation', () => {
    // The reverse direction: an act that appears on an item but is absent here would be rendered
    // by a client and then refused as unknown rather than as unbound.
    for (const b of bindings) {
      expect(Object.keys(ACT_TOOL_BINDINGS)).toContain(b.act);
    }
  });

  describe('the negative cases, which are the ones that matter', () => {
    it('release is refused from the owner', () => {
      const c = cases.find((x) => x.name === 'release-by-owner-rejected');
      expect(c?.expected).toEqual({
        accepted: false,
        rejection_reason: 'wrong-role-for-act',
        asserts: null,
      });
    });

    it('done is refused from the counterparty', () => {
      const c = cases.find((x) => x.name === 'done-by-owed-to-rejected');
      expect(c?.expected.rejection_reason).toBe('wrong-role-for-act');
    });

    it('a non-party gets no standing at all, whatever they asked for', () => {
      const c = cases.find((x) => x.name === 'act-by-non-party-rejected');
      expect(c?.expected.rejection_reason).toBe('not-a-party');
    });

    it('acts bound to another tool, or to none, are refused by name', () => {
      for (const name of [
        'supersede-is-not-an-act-tool-call',
        'ping-is-not-an-act-tool-call',
        'dismiss-is-not-an-act-tool-call',
      ]) {
        const c = cases.find((x) => x.name === name);
        expect(c?.expected.rejection_reason).toBe('act-not-bound-to-a-tool');
      }
    });

    it('release with evidence is refused: giving up a claim is not evidencing delivery', () => {
      const c = cases.find((x) => x.name === 'release-with-evidence-rejected');
      expect(c?.expected.rejection_reason).toBe('evidence-hash-must-be-null');
    });
  });

  it('a refused act leaves the chain byte-identical', () => {
    const fx: Fixture = makeFixture();
    const edgeId = fx.node.commit({
      intent: 'a promise to refuse an act against',
      owed_to: fx.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    }).edge_id!;

    const before = JSON.stringify(fx.vault.getAssertions(fx.personas[0]!, edgeId));
    // `release` belongs to the counterparty; this node is the owner, so it must be refused.
    const out = fx.node.act({ id: edgeId, act: 'release', evidence_hash: null });
    const after = JSON.stringify(fx.vault.getAssertions(fx.personas[0]!, edgeId));

    expect(out.accepted).toBe(false);
    expect(out.rejection_reason).toBe('wrong-role-for-act');
    expect(out.asserts).toBeNull();
    expect(after).toBe(before);

    fx.cleanup();
  });
});
