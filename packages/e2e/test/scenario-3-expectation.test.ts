import { beforeAll, describe, expect, it } from 'vitest';
import { sealEnvelope } from '@servanda/connectors-github';
import {
  confirmProposal,
  mayNeverPropose,
  NotProposableError,
  route,
  VAULT_LOCAL_COUNTERPARTY_UNRESOLVED,
  type ProposableResult,
  type RawExtraction,
  type Routed,
} from '@servanda/extraction';
import {
  Envelope,
  Expectation,
  ProposePayload,
  WireMessageType,
  WirePayload,
  type BriefOutput,
  type Commitment,
  type ConfirmOutput,
  type OpenLoopsOutput,
} from '@servanda/types';
import { alice, freshInstall, type Install } from './support.js';

/**
 * SCENARIO 3 — "Expectation: half-network, the freelancer and a silent client" (scenarios.md §3).
 *
 * You email Georgi an offer and tell the agent "waiting for Georgi's answer on the warehouse
 * offer". Georgi has no agent and will never know the record exists. Nine days later the brief
 * says so; on day eleven he replies, the expectation closes, and a counter-commitment is born —
 * which, because he is still off-network, also stays vault-local, but this one has a due date
 * and escalates to *you*.
 *
 * The whole scenario is one claim: the system tracks what you are owed by people who are not on
 * it, and it never, under any circumstance, reaches out to them. Half a network, a whole product.
 *
 * TWO GAPS this test does not paper over (both reported rather than stubbed):
 *   - There is no IMAP connector in this repository. Georgi's reply is therefore an envelope
 *     built here against the §2 schema — `imap` is in KNOWN_SOURCES, so the object is
 *     spec-legitimate; what does not exist is a connector that would produce it from a mailbox.
 *   - §7 has no verb for closing an expectation. ADR-0013 says the holder "closes them
 *     unilaterally — they are private bookkeeping", so the close below is a vault write. A node
 *     surface tool for it does not exist yet.
 */

const SINCE = '2026-07-22T09:00:00Z';
const GEORGI = 'Georgi/SkladCo';
const AWAITED = 'answer on the warehouse offer';
const PHASE_1 = 'deliver phase 1 of the warehouse work';
const DUE = '2026-09-15T00:00:00Z';

/** Day 11 is 2026-08-02; the due date is 45 days after that. */
const DAYS_TO_DAY_9 = 9;
const DAYS_TO_DAY_11 = 2;
const DAYS_PAST_DUE = 45;

/**
 * What a model would return for "yes, starting September" — the counter-commitment. It is
 * routed rather than trusted: `owner` can only ever be said as `local_user`, so the record
 * this produces is our own promise or nothing.
 */
const COUNTER: RawExtraction = {
  envelope_id: 'set-in-beforeAll',
  intent: PHASE_1,
  owner: 'local_user',
  owner_label: null,
  owed_to: 'other_party',
  owed_to_label: GEORGI,
  due: DUE,
  confidence: 0.91,
  quote: 'yes, starting September',
};

describe('scenario 3 — expectation: the freelancer and the silent client', () => {
  let install: Install;

  let expectationId: string;
  let opened: Expectation;
  let commitmentsAtOpen: unknown[];
  let edgesAtOpen: string[];
  let day9Edges: string[];

  let day9Loops: OpenLoopsOutput;
  let day9Brief: BriefOutput;
  let day9BriefAgain: BriefOutput;
  let day9Outbox: unknown[];
  let day9Escalatable: string[];

  let reply: Envelope;
  let routedCounter: Routed;
  let conversion: ConfirmOutput;
  let closed: Expectation;
  let counterCommitments: { hash: string; commitment: Commitment }[];
  let day11Outbox: unknown[];
  let day11Edges: string[];

  let overdueBrief: BriefOutput;
  let overdueLoops: OpenLoopsOutput;

  let proposeAttempt: { commitment_hash: string; edge_id: string | null; state: string };
  let finalOutbox: unknown[];
  let finalEdges: string[];

  beforeAll(async () => {
    install = await freshInstall(SINCE);

    // ── 22.07: "waiting for Georgi's answer on the warehouse offer" ────────────────────────
    expectationId = install.node.expect({ expect: AWAITED, from: GEORGI, context: null })
      .expectation_id;
    opened = install.vault.getExpectation(alice.personaId, expectationId)!;
    // Snapshotted here rather than read live in the `it`: by the time the assertions run,
    // `beforeAll` has played the whole story out. Each test asserts its own moment.
    commitmentsAtOpen = install.vault.listCommitments(alice.personaId);
    edgesAtOpen = install.vault.listEdgeIds(alice.personaId);

    // ── day 9 ─────────────────────────────────────────────────────────────────────────────
    install.clock.advanceDays(DAYS_TO_DAY_9);
    day9Loops = install.node.openLoops({ view: 'waiting', persona: null, limit: 10 });
    day9Brief = install.node.brief({ persona: null });
    day9BriefAgain = install.node.brief({ persona: null });
    day9Outbox = install.vault.listOutbox(alice.personaId);
    day9Edges = install.vault.listEdgeIds(alice.personaId);
    day9Escalatable = install.node.escalatable(alice.personaId);

    // ── day 11: "yes, starting September" ─────────────────────────────────────────────────
    install.clock.advanceDays(DAYS_TO_DAY_11);
    reply = sealEnvelope({
      v: 'servanda/0.2',
      type: 'envelope',
      source: 'imap',
      kind: 'email_in',
      occurred_at: install.clock.iso(),
      received_at: install.clock.iso(),
      actor: { label: GEORGI },
      payload: { subject: 'Re: warehouse offer', text: 'yes, starting September' },
      refs: [{ kind: 'message', value: '<georgi-2026-08-02@skladco.example>' }],
      persona: alice.personaId,
    });

    const outcome = route(
      { ...COUNTER, envelope_id: reply.id },
      { persona: alice.personaId, createdAt: install.clock.iso() },
    );
    if (!outcome.ok) throw new Error(`routing failed: ${outcome.failure.detail}`);
    routedCounter = outcome.routed;
    if (routedCounter.disposition !== VAULT_LOCAL_COUNTERPARTY_UNRESOLVED) {
      throw new Error(`expected a vault-local counterparty, got ${routedCounter.disposition}`);
    }

    // The conversion is proposed to the human and confirmed by them — §3.4's explicit act. The
    // source is `converted_expectation`, which §3.1 has an enum member for precisely this.
    const candidate: Commitment = {
      ...routedCounter.commitment,
      source: 'converted_expectation',
      evidence_refs: [{ kind: 'envelope', value: reply.id }],
    };
    const pendingId = install.node.queuePendingExtraction(alice.personaId, candidate, reply.id);
    conversion = install.node.confirm({ id: pendingId, decision: 'confirm' });

    // ADR-0013: the holder closes it unilaterally. No §7 verb exists for this, so it is a vault
    // write, filed under the same id so the object's identity survives its state change.
    install.vault.putExpectation(alice.personaId, expectationId, { ...opened, state: 'closed' });
    closed = install.vault.getExpectation(alice.personaId, expectationId)!;

    counterCommitments = install.vault.listCommitments(alice.personaId);
    day11Outbox = install.vault.listOutbox(alice.personaId);
    day11Edges = install.vault.listEdgeIds(alice.personaId);

    // ── past the due date ─────────────────────────────────────────────────────────────────
    install.clock.advanceDays(DAYS_PAST_DUE);
    overdueBrief = install.node.brief({ persona: null });
    overdueLoops = install.node.openLoops({ view: 'owe', persona: null, limit: 10 });

    // Last, so it cannot pollute the snapshots above: take the brief's OWN offered action and
    // ask for a wire proposal. An external label is not a resolvable counterparty, so it is
    // refused — by returning a vault-local record, not by throwing.
    const slot = overdueBrief.slots.find((s) => s.headline === PHASE_1)!;
    // An expectation slot always offers one — a slot with nothing to do is not in the brief.
    const action = slot.primary_action!;
    proposeAttempt = install.node.commit({
      intent: action.args['intent'] as string,
      owed_to: action.args['owed_to'] as string,
      due: DUE,
      persona: null,
      propose: true,
    });
    finalOutbox = install.vault.listOutbox(alice.personaId);
    finalEdges = install.vault.listEdgeIds(alice.personaId);
  });

  it('M-1/ADR-0013: the expectation is a vault object, and nothing else', () => {
    expect(() => Expectation.parse(opened)).not.toThrow();
    expect(opened.expect).toBe(AWAITED);
    expect(opened.from).toBe(GEORGI);
    // `since` is the instant, not a string shape: §7 `expect` stamps it with millisecond
    // precision and the clock renders seconds. Both are RFC 3339.
    expect(Date.parse(opened.since)).toBe(Date.parse(SINCE));
    expect(opened.state).toBe('open');

    // "They said they would" is an expectation, never a promise recorded on their behalf.
    expect(commitmentsAtOpen).toHaveLength(0);
    expect(edgesAtOpen).toHaveLength(0);
  });

  it('M-1: an expectation is not serializable into any §6 wire payload', () => {
    // ADR-0013 states the rule; this is the rule made checkable. There is no wire message type
    // for it, and it fits no payload schema — including as a smuggled field of one.
    expect(WireMessageType.options).not.toContain('expectation');
    expect(WirePayload.safeParse(opened).success).toBe(false);
    expect(ProposePayload.safeParse({ edge: opened, assertion: opened }).success).toBe(false);
    expect(WirePayload.safeParse({ expectation: opened }).success).toBe(false);
  });

  it('produces no outbound artefact of any kind for the counterparty (day 9)', () => {
    // The system cannot and may not chase Georgi. Not "does not by default" — there is nothing
    // queued for anybody, nothing signed, and no edge that could carry a state to him.
    expect(day9Outbox).toEqual([]);
    expect(day9Edges).toEqual([]);
    expect(day9Escalatable).toEqual([]);

    // And he is not a routable identity here: a label is level 0 evidence, forever (M-12).
    expect(install.node.verificationLevel(alice.personaId, GEORGI)).toBe('0');
  });

  it('surfaces on day 9 as "waiting on Georgi for 9 days"', () => {
    expect(day9Loops.items).toHaveLength(1);
    const item = day9Loops.items[0]!;
    expect(item.kind).toBe('expectation');
    expect(item.id).toBe(expectationId);
    expect(item.intent_or_expect).toBe(AWAITED);
    expect(item.counterparty?.value).toBe(GEORGI);
    expect(item.age_days).toBe(DAYS_TO_DAY_9);
    expect(item.state).toBe('open');

    const slot = day9Brief.slots.find((s) => s.item_id === expectationId);
    expect(slot).toBeDefined();
    expect(slot!.headline).toBe(AWAITED);
  });

  it('states rather than nags: one offer, on the holder’s initiative, escalating to nobody', () => {
    // The register is structural. The only action is `ping` — something the holder may choose,
    // never something the node does. There is no due date to be late against, and re-reading the
    // brief produces the same single line rather than an accumulating one.
    expect(day9Loops.items[0]!.actions).toEqual([{ act: 'ping', tool: null, args: {} }]);
    expect(day9Loops.items[0]!.due).toBeNull();
    // The one affordance is `ping`, and v0 binds it to no tool — the freelancer is offered a
    // nudge they must send themselves, not a button that silently does nothing. Asserted as an
    // act because the word "Ping" belongs to whichever client paints it (M-21).
    expect(day9Brief.slots.find((s) => s.item_id === expectationId)!.primary_action).toEqual({
      act: 'ping',
      tool: null,
      args: {},
    });
    expect(JSON.stringify(day9BriefAgain.slots)).toBe(JSON.stringify(day9Brief.slots));
    expect(day9Brief.slots.filter((s) => s.item_id === expectationId)).toHaveLength(1);
  });

  it('day 11: the reply closes the expectation and creates the counter-commitment', () => {
    expect(() => Envelope.parse(reply)).not.toThrow();
    expect(conversion.state).toBe('confirmed');
    expect(closed.state).toBe('closed');
    // Closing changes the state, not the history: what was awaited and since when both survive.
    expect(closed.expect).toBe(AWAITED);
    expect(Date.parse(closed.since)).toBe(Date.parse(SINCE));

    expect(counterCommitments).toHaveLength(1);
    const counter = counterCommitments[0]!.commitment;
    expect(counter.intent).toBe(PHASE_1);
    // The direction has flipped: what you awaited is now what you owe.
    expect(counter.owner).toBe(alice.personaId);
    expect(counter.owed_to).toBe(GEORGI);
    expect(counter.due).toBe(DUE);
    expect(counter.source).toBe('converted_expectation');
    expect(counter.evidence_refs[0]).toEqual({ kind: 'envelope', value: reply.id });
  });

  it('M-1/§3.1: an external_label counterparty never yields a wire propose', () => {
    // Two independent locks, because this is the point at which the half-network case could
    // leak. First the type system: routing hands out a disposition that `confirmProposal` will
    // not accept, and the only disposition it accepts is not this one.
    expect(routedCounter.disposition).toBe(VAULT_LOCAL_COUNTERPARTY_UNRESOLVED);
    expect(mayNeverPropose(routedCounter)).toBe(true);
    expect(() =>
      confirmProposal(routedCounter as unknown as ProposableResult, {
        persona: alice.personaId,
        confirmedAt: install.clock.iso(),
      }),
    ).toThrow(NotProposableError);

    // Then the node surface: asking for `propose: true` on a labelled counterparty returns a
    // vault-local record. Georgi is a string, not an identity, and there is nowhere to send it.
    expect(proposeAttempt.state).toBe('vault-local');
    expect(proposeAttempt.edge_id).toBeNull();

    // Still nothing outbound, at any point in the story.
    expect(day11Outbox).toEqual([]);
    expect(day11Edges).toEqual([]);
    expect(finalOutbox).toEqual([]);
    expect(finalEdges).toEqual([]);
  });

  it('escalates the counter-commitment to its owner, and only to its owner', () => {
    // A due date it can be late against — the difference from the expectation, which had none.
    // With no edge there is no M-8 auto-escalation to run; escalation reaches the holder through
    // the attention market, where the overdue band outranks everything undated.
    const owed = overdueLoops.items.find((i) => i.intent_or_expect === PHASE_1);
    expect(owed).toBeDefined();
    expect(owed!.due).toBe(DUE);
    expect(owed!.counterparty?.value).toBe(GEORGI);

    expect(overdueBrief.slots[0]!.headline).toBe(PHASE_1);
    expect(install.node.escalatable(alice.personaId)).toEqual([]);
    expect(install.vault.listOutbox(alice.personaId)).toEqual([]);
  });

  it('the closed expectation has left the waiting view', () => {
    const waiting = install.node.openLoops({ view: 'waiting', persona: null, limit: 10 });
    expect(waiting.items.find((i) => i.id === expectationId)).toBeUndefined();

    const closedView = install.node.openLoops({ view: 'closed', persona: null, limit: 10 });
    expect(closedView.items.find((i) => i.id === expectationId)).toBeDefined();
  });
});
