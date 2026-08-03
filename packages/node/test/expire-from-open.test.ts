import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { edgeId, withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Assertion, type Edge } from '@servanda/types';
import { makeFixture, nodeAs, persona, syncEdge, type Fixture } from './support/fixture.js';

/**
 * §4.3's first `expired` row, from the seat of the person holding the promise.
 *
 * §4.3 gives `open → expired` to **either party after `due`**, and §4.4 relies on it: the
 * `contested-closure` reasoning is built on "`expired` by either once `due` has passed" being an
 * act a party can take. The transition table implements it, `act` signs it, and the §7 surface
 * advertised it nowhere — so an edge whose due date passed a year ago sat in a person's register
 * offering `done`, `supersede` and `delegate`, none of which end it, while the one act that does
 * was reachable only by a client that guessed.
 *
 * This is the same defect `expire` was added to fix for `disputed` and `contested-closure`,
 * surviving one state further along: correct in the table, unreachable where a person stands. It
 * was found the same way both previous times — by asking what a party is supposed to press — and
 * §7 even records the symptom without noticing it: "Where `expire` sorts against `done` and
 * `release` is stated here and exercised by no case, because on the current rules no state
 * advertises it alongside either." A vocabulary order nothing exercises is a rule about a
 * situation that cannot arise. It can arise; this is it.
 */

const OWNER = persona(0);

/** The fixture clock. `due` values are chosen either side of it. */
const NOW = new Date('2026-07-25T09:00:00.000Z');
const PAST = '2026-07-20T09:00:00.000Z';
const FUTURE = '2026-09-01T09:00:00.000Z';

let fx: Fixture;
let overdue: string;
let overdueForAct: string;
let notYetDue: string;
let undated: string;

/**
 * ONE vault, four edges. A distinct `intent` is a distinct `commitment_hash` is a distinct edge,
 * at no cost; a second fixture is a second Argon2id derivation and a second git repository, which
 * is what turns this file into the vitest worker timeout the config documents.
 */
function openEdge(intent: string, due: string | null): string {
  const { edge_id } = fx.node.commit({
    intent,
    owed_to: fx.personas[1]!,
    due,
    persona: null,
    propose: true,
  });
  if (edge_id === null) throw new Error('the fixture failed to propose');
  syncEdge(fx, 0, 1, edge_id);
  nodeAs(fx, 1).confirm({ id: edge_id, decision: 'confirm' });
  syncEdge(fx, 1, 0, edge_id);
  return edge_id;
}

beforeAll(() => {
  fx = makeFixture({ now: NOW });
  overdue = openEdge('the advertisement', PAST);
  overdueForAct = openEdge('the act itself', PAST);
  notYetDue = openEdge('not yet', FUTURE);
  undated = openEdge('no date at all', null);
});
afterAll(() => fx.cleanup());

const itemFor = (node: { openLoops: Fixture['node']['openLoops'] }, id: string, view: 'owe' | 'waiting') =>
  node.openLoops({ persona: null, view, limit: 500 }).items.find((i) => i.id === id);

describe('§4.3 open → expired: the exit is advertised where it is legal', () => {
  it('the edges are genuinely open, and the table genuinely permits the act', () => {
    // Stated first so a failure below cannot be read as a broken fixture. If these two facts hold
    // and the advertisement is missing, the gap is exactly the one this file is about.
    expect(fx.node.edgeState(OWNER.personaId, overdue).final_state).toBe('open');
    expect(fx.node.edgeState(OWNER.personaId, notYetDue).final_state).toBe('open');
  });

  it('offers `expire` to the owner once `due` has passed', () => {
    const actions = itemFor(fx.node, overdue, 'owe')!.actions;
    expect(actions.map((a) => a.act)).toContain('expire');
    expect(actions.find((a) => a.act === 'expire')).toEqual({
      act: 'expire',
      tool: 'act',
      args: { id: overdue, act: 'expire' },
    });
  });

  it('and to the party owed, who is not the owner and is trapped just as squarely', () => {
    // §4.3 says "either party", and §7 says of the deadlock states that the escape "has to reach
    // whoever is trapped and both of them are". A creditor holding an edge a year past its due
    // date is in that position: `release` forgives the debt, which is a verdict, and expiry is the
    // exit that decides nothing.
    const them = nodeAs(fx, 1);
    const actions = itemFor(them, overdue, 'waiting')!.actions;
    expect(actions.map((a) => a.act)).toContain('expire');
  });

  it('places `expire` by §7’s rule and not at the end of the list', () => {
    // `done` · `release` · `expire` · … — most-consequential-first. §7 says this ordering "is
    // stated here and exercised by no case"; it is exercised now, and by the only two states that
    // can exercise it.
    expect(itemFor(fx.node, overdue, 'owe')!.actions.map((a) => a.act)).toEqual([
      'done',
      'expire',
      'supersede',
      'delegate',
    ]);
    const them = nodeAs(fx, 1);
    expect(itemFor(them, overdue, 'waiting')!.actions.map((a) => a.act)).toEqual([
      'release',
      'expire',
      'ping',
      'supersede',
    ]);
  });

  it('withholds it while `due` is still in the future', () => {
    expect(itemFor(fx.node, notYetDue, 'owe')!.actions.map((a) => a.act)).not.toContain('expire');
  });

  it('and withholds it for ever on an undated promise', () => {
    // §3.1: "undated commitments MUST NOT time-escalate." There is no `due` for expiry to be
    // after, so this is not "not yet" — it is never, and the refusal below says so.
    expect(itemFor(fx.node, undated, 'owe')!.actions.map((a) => a.act)).not.toContain('expire');
  });

  it('signs it when pressed', () => {
    expect(fx.node.act({ id: overdueForAct, act: 'expire', evidence_hash: null })).toEqual({
      accepted: true,
      rejection_reason: null,
      asserts: 'expired',
    });
    expect(fx.node.edgeState(OWNER.personaId, overdueForAct).final_state).toBe('expired');
  });

  it('refuses it before `due` with "not yet" and not with "never"', () => {
    // The complaint §7's rejection table opens with, reproduced on this transition: `expire` from
    // `open` before `due` reported `illegal-source-state` — "you may never do this" — when the
    // truth is that this is one of the two states from which it IS legal and the only thing wrong
    // is the clock. That is the argument that earned `acceptance-window-not-elapsed` its row and
    // then `dispute-window-not-elapsed` its own.
    expect(fx.node.act({ id: notYetDue, act: 'expire', evidence_hash: null })).toMatchObject({
      accepted: false,
      rejection_reason: 'due-not-elapsed',
    });
  });

  it('and refuses it on an undated promise with "never", which is the true answer there', () => {
    expect(fx.node.act({ id: undated, act: 'expire', evidence_hash: null })).toMatchObject({
      accepted: false,
      rejection_reason: 'illegal-source-state',
    });
  });
});

/**
 * The other §7 read surface, on the same act.
 *
 * §7: "a node MUST NOT describe an act differently on the two surfaces." `brief` built its slot
 * through the same `actionsFor` and passed neither window flag, so for every state whose only
 * signing act is gated on a window the brief computed the ungated answer — `supersede`, bound to
 * no tool — and `primary_action` came back `null`. A person whose surface is the brief was told
 * there was nothing to press on precisely the edges that had an escape.
 */
describe('§7: the brief and open_loops describe the same act', () => {
  const ME = persona(0);
  const THEM = persona(1);
  const EVIDENCE = 'e'.repeat(64);
  const CONTEST_AT = '2026-06-15T09:00:00Z';

  let deadlocked: Fixture;
  let contested: Edge;

  const assertionOn = (
    edge: Edge,
    state: 'proposed' | 'confirmed' | 'closed' | 'released',
    by: typeof ME,
    at: string,
    evidence: string | null = null,
  ): Assertion =>
    withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'assertion' as const,
        edge_id: edge.edge_id,
        state,
        asserted_at: at,
        by: by.personaId,
        evidence_hash: evidence,
      },
      by.privateKey,
    ) as Assertion;

  beforeAll(() => {
    deadlocked = makeFixture({ now: new Date('2026-07-20T09:00:00.000Z') });
    const body = {
      commitment_hash: 'c'.repeat(64),
      owner: ME.personaId,
      owed_to: THEM.personaId,
      proposed_at: '2026-06-01T09:00:00Z',
    };
    contested = {
      v: PROTOCOL_VERSION,
      type: 'edge',
      edge_id: edgeId(body),
      ...body,
      due: null,
      closure_policy: 'on-evidence',
      acceptance_window: null,
      blocked_by: [],
      supersedes: null,
    };
    deadlocked.vault.putEdge(ME.personaId, contested);
    deadlocked.vault.appendAssertion(ME.personaId, assertionOn(contested, 'proposed', ME, '2026-06-01T09:00:00Z'));
    deadlocked.vault.appendAssertion(ME.personaId, assertionOn(contested, 'confirmed', THEM, '2026-06-02T09:00:00Z'));
    deadlocked.vault.appendAssertion(ME.personaId, assertionOn(contested, 'closed', ME, CONTEST_AT, EVIDENCE));
    deadlocked.vault.appendAssertion(ME.personaId, assertionOn(contested, 'released', THEM, CONTEST_AT));
  });
  afterAll(() => deadlocked.cleanup());

  it('is genuinely deadlocked, and past the window', () => {
    expect(deadlocked.node.edgeState(ME.personaId, contested.edge_id).final_state).toBe('contested-closure');
    const actions = deadlocked.node
      .openLoops({ persona: null, view: 'all', limit: 500 })
      .items.find((i) => i.id === contested.edge_id)!.actions;
    expect(actions.map((a) => a.act)).toEqual(['expire', 'supersede']);
  });

  it('the brief leads with the act that ends it, not with null', () => {
    const slot = deadlocked.node.brief({ persona: null }).slots.find((s) => s.item_id === contested.edge_id);
    expect(slot).toBeDefined();
    expect(slot!.primary_action).toEqual({
      act: 'expire',
      tool: 'act',
      args: { id: contested.edge_id, act: 'expire' },
    });
  });
});
