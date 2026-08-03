import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { derivePersona } from '@servanda/crypto';
import { FederatedNode, GitTransport, MemoryHub, OutboundDeliveryError } from '@servanda/federation';
import type { Transport } from '@servanda/federation';
import { join } from 'node:path';
import { dhDirectory, hubTransport, twoPeople, type TwoPeople } from './two-people.js';
import { seed, TestClock } from './support.js';

/**
 * Ana keeps her node on a shared git repository. Boyan collects his mail at an HTTPS hub.
 *
 * OBSERVED BEFORE ANY OF THIS WAS WRITTEN, by standing the two transports up and running the
 * promise through them:
 *
 *   ANA push: 1  err: null
 *   BOYAN pull: {"accepted":[],"discarded":[],…}      ← not even a discard
 *   ANA outbox item keys: ["v","type","id","persona","recipient","message","queued_at"]
 *   ANA register: [{… "state":"proposed", "actions":[{"act":"ping"}]}]
 *
 * `push` returned **1**, which is the number of messages successfully delivered. Nothing had been
 * delivered to anybody. Ana's register said `proposed` and offered her a `ping`, which is the
 * screen it would show if Boyan were reading her promise and declining to answer. Boyan's node
 * had no record that anything had ever been addressed to him, because nothing had: her file went
 * into a repository he does not clone, and his node reads a hub she does not post to.
 *
 * Two people, two correct nodes, one protocol, and not one screen on either side that says why
 * the conversation is not happening.
 *
 * What this story now walks through is the same promise in three states — unroutable, sent,
 * acknowledged — and the sentence a person reads in each. The three are genuinely different
 * claims, and it matters that a product never collapses them:
 *
 *   - **unroutable** — nothing has left this machine, and nothing will until a route exists.
 *   - **sent** — a courier accepted the bytes. That is ALL a git push or an HTTP 200 establishes;
 *     neither says a node fetched them, let alone that a person read them.
 *   - **acknowledged** — the counterparty signed something naming this edge. §4.1 binds
 *     `edge_id` to the edge body, so that signature could not exist unless the message arrived.
 *     It is the only one of the three the recipient authors, and the only one worth trusting.
 */

const START = '2026-03-02T09:00:00Z';
const HUB = 'https://hub.example';

const ana = derivePersona(seed, 0);
const boyan = derivePersona(seed, 1);

describe('§6.1 — a person on a shared repository and a person on a hub', () => {
  let people: TwoPeople;
  let clock: TestClock;
  let anaFed: FederatedNode;
  let boyanFed: FederatedNode;
  let edge: string;
  /** Ana's route table. Empty means: this node holds no courier that reaches Boyan. */
  const anaRoutes = new Map<string, Transport>();
  let anaHub: Transport;

  beforeAll(() => {
    const hub = new MemoryHub({ now: () => new Date(START) });
    const resolve = dhDirectory([ana, boyan], { now: () => new Date(START) });
    people = twoPeople([['ana', 0], ['boyan', 1]], START, {
      transportFor: ({ who }) =>
        who === 'boyan'
          ? hubTransport({ hub, baseUrl: HUB, persona: boyan, resolveDhKey: resolve, now: () => new Date(START) })
          : null,
    });
    clock = people.clock;
    const [anaSide, boyanSide] = people.sides;

    anaHub = hubTransport({ hub, baseUrl: HUB, persona: ana, resolveDhKey: resolve, now: clock.now });

    anaFed = new FederatedNode({
      vault: anaSide!.vault,
      persona: ana.personaId,
      // She still READS her own shared repository; the route table governs what she writes.
      transport: anaSide!.transport,
      routeFor: (recipient) => anaRoutes.get(recipient) ?? null,
      now: clock.now,
    });

    // Boyan reads his hub, and answers Ana over a clone of the repository she is on. Reaching
    // someone means holding a courier that reaches them — on both sides, separately.
    const boyanGit = GitTransport.init({
      dir: join(people.root, 'boyan-clone'),
      persona: boyan.personaId,
      remote: people.shared,
    });
    boyanFed = new FederatedNode({
      vault: boyanSide!.vault,
      persona: boyan.personaId,
      transport: boyanSide!.transport,
      routeFor: (recipient) => (recipient === ana.personaId ? boyanGit : null),
      now: clock.now,
    });

    edge = anaSide!.node.commit({
      intent: 'review the draft',
      owed_to: boyan.personaId,
      due: '2026-03-06T17:00:00Z',
      propose: true,
      persona: null,
    }).edge_id!;
  });

  afterAll(() => people?.cleanup());

  it('says so, in words, instead of reporting a delivery that did not happen', async () => {
    const error = await anaFed.push().then(
      () => null,
      (e: unknown) => e,
    );
    // It is not silently dropped. The old flow did not throw here — it returned 1.
    expect(error).toBeInstanceOf(OutboundDeliveryError);
    expect((error as OutboundDeliveryError).delivered).toBe(0);

    const [status] = anaFed.outbound();
    expect(status!.edge_id).toBe(edge);
    expect(status!.state).toBe('unroutable');
    expect(status!.explanation).toContain('never left this machine');

    // And the observation that started this: Boyan's side is genuinely empty, which is why the
    // sentence has to come from Ana's own node. No courier is going to tell her.
    const heard = await boyanFed.pull();
    expect(heard.accepted).toEqual([]);
  });

  it('crosses once she holds a courier that reaches him — and claims only what that proves', async () => {
    anaRoutes.set(boyan.personaId, anaHub);
    clock.advanceDays(1);

    expect(await anaFed.push()).toBe(1);
    const [sent] = anaFed.outbound();
    expect(sent!.state).toBe('sent');
    expect(sent!.sent_via).toBe('hub');
    expect(sent!.acknowledged_at).toBeNull();
    // The wording refuses the inference a person would otherwise make from a green checkmark.
    expect(sent!.explanation).toContain('not that');

    // He really did get it — over a transport neither node shares with the other.
    const heard = await boyanFed.pull();
    expect(heard.accepted).toContainEqual({ type: 'propose', edge_id: edge });
  });

  it('becomes acknowledged only when Boyan himself signs for it', async () => {
    clock.advanceDays(1);
    people.sides[1]!.node.confirm({ id: edge, decision: 'confirm' });
    await boyanFed.push();

    await anaFed.pull();
    const [ack] = anaFed.outbound();
    expect(ack!.state).toBe('acknowledged');
    expect(ack!.acknowledged_at).not.toBeNull();
    expect(ack!.explanation).toContain('proof they received it');

    // What acknowledgement is FOR: a promise the counterparty has provably read is no longer
    // re-presented to a courier on every push, so a restart stops re-sending it.
    expect(await anaFed.push()).toBe(0);
  });
});
