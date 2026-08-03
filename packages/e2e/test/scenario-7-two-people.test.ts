import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { derivePersona } from '@servanda/crypto';
import {
  FederatedNode,
  MemoryHub,
  ProposalBudget,
  RecoveryResponder,
  applyRecoverResponse,
  buildReconRequest,
  signChallenge,
  signMessage,
  signRotation,
} from '@servanda/federation';
import { COPY, buildLedger, type LedgerView } from '@servanda/client-web';
import { ActInput } from '@servanda/types';
import {
  dhDirectory,
  hubTransport,
  outageFetch,
  settle,
  twoPeople,
  type TwoPeople,
} from './two-people.js';
import { seed, signAssertion } from './support.js';

/**
 * SCENARIO 7 — "Two people, two machines" (§6).
 *
 * Everything up to §5 of `docs/USAGE.md` is one person and one vault. This file starts where a
 * promise stops being solo, and it asks a question the crypto and state-machine passes never had
 * to: **what does each person SEE, and is it the truth?**
 *
 * So every assertion here is about a surface a person reads — `open_loops`, `brief`, the register's
 * verification level — or about a message actually arriving. Chain state is checked only where a
 * person would notice the difference.
 *
 * This file pins what a person SEES, so that changing it breaks these tests loudly instead of
 * silently. That is not a figure of speech: three of the five gaps below were written as
 * REPORTED, with assertions recording the wrong behaviour, and all three failed the moment they
 * were fixed — which is how they came to be fixed in one pass rather than rediscovered in three.
 *
 * FIXED since this file was written:
 *
 *   - **The ledger sorted by object kind, not by who owes whom.** `buildLedger` bucketed on
 *     `item.kind === 'expectation'` and an edge is `kind: 'edge'` for BOTH parties, so the person
 *     a promise was made TO read it under "You owe", beside a control letting them forgive the
 *     debt the heading said they carried. The client asks the node for `view: 'owe'` and
 *     `view: 'waiting'` now instead of re-deriving an answer the node already has.
 *   - **`contested-closure` had no home, no exit and no words.** It is live in `open_loops`, it
 *     advertises `supersede` exactly as `disputed` does and for the same reason (§7/#41), and it
 *     has a sentence of its own rather than a date that no longer governs.
 *   - **Dismissing and then confirming left the confirmer with no surface at all.** Signing
 *     clears the dismissal; a dismissal nobody reversed still hides the promise.
 *   - **§1.6 continuity did not follow a §1.7 rotation.** Level 1 travels the key lineage now, so
 *     a counterparty who recovers their key stays somebody you have dealt with. Levels 2 and 3
 *     deliberately do NOT travel: an org attestation is a third party's statement about a
 *     specific key, and §1.7 transfers edges, not vouching.
 *
 *   - **The recipient was told the words had been DELETED.** M-7 keeping plaintext off the wire
 *     is the protocol working, but the node had one string for that and for M-15 retention — so
 *     the ordinary first-contact case read as destroyed data, with `confirm` beside it. The two
 *     causes have their own sentences now, chosen from `plaintext_deleted_at`.
 *
 * STILL OPEN, and pinned here as what a person sees today:
 *
 *   1. **Two people who remember a promise differently have the same screen as two who agree.**
 *      The recipient holds a hash and no words, and there is nowhere for them to record what
 *      THEY believe was promised. The protocol makes the disagreement provable later, because
 *      the hash binds; the product makes it undiscoverable now.
 */

const START = '2026-03-02T09:00:00Z';
const EVIDENCE = 'e'.repeat(64);
const HUB = 'https://hub.example';

const ana = derivePersona(seed, 0);
const boyan = derivePersona(seed, 1);
/** The key Boyan moves to when he rotates. */
const boyanNext = derivePersona(seed, 12);
/** Somebody who has never heard of Servanda and never will. */
const stranger = derivePersona(seed, 13);

let open: TwoPeople[] = [];
const track = (p: TwoPeople): TwoPeople => {
  open.push(p);
  return p;
};
afterAll(() => {
  for (const p of open) p.cleanup();
  open = [];
});

function promise(from: TwoPeople['sides'][number], to: string, intent: string, due: string): string {
  const out = from.node.commit({ intent, owed_to: to, due, propose: true, persona: null });
  return out.edge_id!;
}

describe('a promise to someone who will never answer', () => {
  it('is still on my register a year later, and nothing says whether it ever arrived', async () => {
    const people = track(twoPeople([['ana', 0]], START));
    const [me] = people.sides;
    const edge = promise(me!, stranger.personaId, 'review the draft', '2026-03-06T17:00:00Z');
    await me!.fed.push();

    people.clock.advanceDays(365);
    const owed = me!.node.openLoops({ persona: null, view: 'owe', limit: 10 });
    const item = owed.items.find((i) => i.id === edge)!;

    // What held: it does not vanish, it does not silently close, and it ages honestly. A promise
    // nobody answered is still a promise I made.
    expect(item.state).toBe('proposed');
    expect(Math.round(item.age_days)).toBe(365);
    expect(item.intent_or_expect).toBe('review the draft');
    // §4.3 gives the owner no transition out of `proposed`, so the one affordance signs nothing.
    expect(item.actions.map((a) => a.act)).toEqual(['ping']);

    // Was REPORTED: the outbox had no delivery state at all — `{id, recipient, message,
    // queued_at}` — so a year of silence and a year of being ignored rendered identically, and
    // the register could not say "handed over, never answered" because nothing recorded that it
    // had been handed over. The register still says `proposed`, correctly: §4.3 knows of no
    // delivery, and inventing a state there would be a protocol change to solve a product problem.
    // The distinction lives beside it, on the message rather than on the edge.
    const [status] = me!.fed.outbound();
    expect(status!.edge_id).toBe(edge);
    expect(status!.state).toBe('sent');
    expect(status!.acknowledged_at).toBeNull();
    // And the sentence is careful about which of the two years this is. A git push that returned
    // zero proves the file is in a repository; the stranger has never cloned it, and no courier
    // can tell her that. What it must not do is imply he read it and shrugged.
    expect(status!.explanation).toContain('365 day(s) ago');
    expect(status!.explanation).toContain('not that');
    expect(status!.explanation).toContain('nothing has come back');
  });
});

describe('§6.5 — the budget a poll must not spend', () => {
  it('one proposal costs one unit however many times the transport re-presents it', async () => {
    // Both shipped transports re-present what they hold on every read: the git tree is re-read
    // whole, and §6.7's hub queue is not drained by `inbox`. A person who polls is not receiving
    // new proposals.
    const budget = new ProposalBudget({ levelZeroCap: 5, perUnknownSenderLimit: 3 });
    const people = track(
      twoPeople(
        [
          ['ana', 0],
          ['boyan', 1],
        ],
        START,
        { budgetFor: (who) => (who === 'boyan' ? budget : undefined) },
      ),
    );
    const [a, b] = people.sides;

    promise(a!, b!.persona.personaId, 'send the quote', '2026-03-06T17:00:00Z');
    await a!.fed.push();

    // Four polls, one more than `perUnknownSenderLimit`. Before, the fourth came back
    // `rate-limited` on a proposal this node had already surfaced three polls earlier.
    for (let i = 0; i < 4; i++) await b!.fed.pull();
    expect(budget.spent()).toEqual({ levelZeroSurfaced: 1, levelZeroCap: 5 });

    // And the SECOND, genuinely new promise still reaches him. Before, five polls had spent the
    // per-sender allowance on the first one, and this arrived `suppressed` — which §6.5 makes
    // silent, so neither person could have found out.
    const second = promise(a!, b!.persona.personaId, 'and the revised scope', '2026-03-09T17:00:00Z');
    await a!.fed.push();
    const got = await b!.fed.pull();

    expect(got.suppressed).toEqual([]);
    expect(got.accepted).toContainEqual({ type: 'propose', edge_id: second });
    expect(b!.node.openLoops({ persona: null, view: 'waiting', limit: 10 }).items).toHaveLength(2);
  });
});

describe('the hub was down when I made the promise', () => {
  it('a refused delivery is retried, not remembered as sent', async () => {
    let down = false;
    let people: TwoPeople;
    const now = (): Date => people.clock.now();
    const hub = new MemoryHub({ baseUrl: HUB, now });
    const resolve = dhDirectory([ana, boyan], { now });
    people = track(
      twoPeople(
        [
          ['ana', 0],
          ['boyan', 1],
        ],
        START,
        {
          transportFor: ({ personaId }) =>
            hubTransport({
              hub,
              baseUrl: HUB,
              persona: personaId === ana.personaId ? ana : boyan,
              resolveDhKey: resolve,
              now,
              fetch: outageFetch(hub, () => down),
            }),
        },
      ),
    );
    const [a, b] = people.sides;
    const edge = promise(a!, b!.persona.personaId, 'send the revised quote', '2026-03-20T17:00:00Z');

    down = true;
    await expect(a!.fed.push()).rejects.toThrow(/503/);

    // The hub comes back. Ana's node has not restarted — it is the same process, the same object.
    people.clock.advanceDays(7);
    down = false;
    expect(await a!.fed.push()).toBe(1);

    const got = await b!.fed.pull();
    expect(got.accepted).toContainEqual({ type: 'propose', edge_id: edge });
    expect(b!.node.openLoops({ persona: null, view: 'waiting', limit: 10 }).items[0]!.state).toBe('proposed');

    // Why this one matters more than the other lost-message cases: §6.4 reconciliation "never
    // introduces an edge", so a lost `propose` is the one message reconciliation cannot heal.
    // Delivery is an optimization for everything except the message that starts the relationship.
  });
});

/**
 * One pair of vaults, four promises, one rotation — because the fixture is the expensive part and
 * the story is the same story. Each case below continues from the same moment: Boyan has moved to
 * a new key and told Ana, and every one of the four promises is `open` under the key he left.
 */
describe('§1.7 — the counterparty rotates their key mid-conversation', () => {
  let people: TwoPeople;
  let a: TwoPeople['sides'][number];
  let b: TwoPeople['sides'][number];
  let rotation: ReturnType<typeof signRotation>;
  const edges: Record<'released' | 'addressed' | 'reconciled' | 'recovered', string> = {
    released: '',
    addressed: '',
    reconciled: '',
    recovered: '',
  };

  beforeAll(async () => {
    people = track(
      twoPeople(
        [
          ['ana', 0],
          ['boyan', 1],
        ],
        START,
      ),
    );
    [a, b] = people.sides as [typeof a, typeof b];

    for (const key of Object.keys(edges) as (keyof typeof edges)[]) {
      edges[key] = promise(a, b.persona.personaId, `a promise that outlives a key (${key})`, '2026-03-20T17:00:00Z');
    }
    await settle(people);
    for (const id of Object.values(edges)) b.node.confirm({ id, decision: 'confirm' });
    await settle(people);
    for (const id of Object.values(edges)) {
      expect(a.node.edgeState(a.persona.personaId, id).final_state).toBe('open');
    }

    // Boyan moves to a new key and tells Ana, from the key he is moving to.
    people.clock.advanceDays(2);
    rotation = signRotation(b.persona.personaId, boyanNext.personaId, people.clock.iso(), b.persona.privateKey);
    const announced = a.fed.inbox.ingest([
      signMessage('rotation', rotation, boyanNext.personaId, a.persona.personaId, people.clock.iso(), boyanNext.privateKey),
    ]);
    expect(announced.accepted).toContainEqual({ type: 'rotation', edge_id: null });
    people.clock.advanceDays(1);
  });

  const releaseBy = (edge: string) =>
    signAssertion(
      { personaId: boyanNext.personaId, privateKey: boyanNext.privateKey },
      { edge_id: edge, state: 'released', asserted_at: people.clock.iso() },
    );

  it('the successor is heard — §1.7: `new` succeeds `old` for all open edges of `old`', () => {
    // Before, this was discarded `sender-is-not-a-party` at the inbox door: the §4.3 table
    // resolved a signer through the rotation lineage, and every party gate in the federation
    // layer compared keys literally. So a counterparty who took the seedless recovery path could
    // never close, release or dispute anything again, and Ana's register showed the promise open
    // for ever against a key nobody holds.
    const edge = edges.released;
    const heard = a.fed.inbox.ingest([
      signMessage(
        'assert',
        { assertion: releaseBy(edge) },
        boyanNext.personaId,
        a.persona.personaId,
        people.clock.iso(),
        boyanNext.privateKey,
      ),
    ]);
    expect(heard.discarded).toEqual([]);
    expect(heard.accepted).toContainEqual({ type: 'assert', edge_id: edge });
    expect(a.node.edgeState(a.persona.personaId, edge).final_state).toBe('released');
  });

  it('and my own acts are addressed to the key they hold now', async () => {
    // The edge body is immutable (§4.1) and still names the key Boyan had, so every act Ana takes
    // after the rotation was posted to a persona nobody reads — one-way, with neither register
    // saying why.
    const edge = edges.addressed;
    expect(a.node.act(ActInput.parse({ id: edge, act: 'done', evidence_hash: EVIDENCE })).accepted).toBe(true);

    const addressed: string[] = [];
    await new FederatedNode({
      vault: a.vault,
      persona: a.persona.personaId,
      now: people.clock.now,
      transport: {
        kind: 'git' as const,
        send: async (recipient: string) => void addressed.push(recipient),
        receive: async () => [],
        sync: async () => {},
      },
    }).push();
    expect(addressed).toContain(boyanNext.personaId);
  });

  it('and §6.4 reconciliation still converges across the rotation', () => {
    const edge = edges.reconciled;

    // Ana asks the successor what she is missing. Before, the request went out EMPTY — the edge
    // names the old key, so `sharedOpenEdges` found nothing shared with the persona she was
    // talking to, and §6.4's "both sides see the same chain" had nothing to say.
    const request = buildReconRequest(a.vault, a.persona.personaId, boyanNext.personaId);
    expect(request.edges.map((e) => e.edge_id)).toContain(edge);

    const applied = a.fed.inbox.ingest([
      signMessage(
        'recon_response',
        { edges: [{ edge_id: edge, assertions: [releaseBy(edge)] }] },
        boyanNext.personaId,
        a.persona.personaId,
        people.clock.iso(),
        boyanNext.privateKey,
      ),
    ]);
    expect(applied.recon.ignored).toEqual([]);
    expect(applied.recon.discarded).toEqual([]);
    expect(a.node.edgeState(a.persona.personaId, edge).final_state).toBe('released');
  });

  it('and §6.6 gives the rotated key back its own history', () => {
    const edge = edges.recovered;

    // Boyan stands up a fresh vault under the new key, holding nothing but his own §1.7 statement
    // — which is what makes him a party to his own history.
    const fresh = track(twoPeople([['boyan2', 12]], people.clock.iso()));
    const restored = fresh.sides[0]!;
    restored.vault.putRotation(restored.persona.personaId, rotation);

    const responder = new RecoveryResponder({ vault: a.vault, persona: a.persona.personaId, now: people.clock.now });
    const challenge = responder.issueChallenge();
    const { verdict, response } = responder.answer({
      persona: boyanNext.personaId,
      proof: { ...signChallenge(challenge, boyanNext.privateKey), rotation } as never,
    });
    expect(verdict.verified).toBe(true);
    expect(response.edges.map((e) => e.edge.edge_id)).toContain(edge);

    // Ana served it correctly all along. The applier is what threw it away: every edge names the
    // OLD key and the party test was a literal comparison, so recovery under a rotated key —
    // which §6.6 names explicitly — restored nothing at all.
    const applied = applyRecoverResponse(restored.vault, restored.persona.personaId, response);
    expect(applied.restored).toContain(edge);
    expect(restored.node.edgeState(restored.persona.personaId, edge).final_state).toBe('open');
  });

  it('and my register still knows who he is — recovering a key is not becoming a stranger', () => {
    // Was REPORTED. `verificationLevel` compared keys literally, so after Ana accepted Boyan's
    // §1.7 statement his NEW key graded `0` while his old one kept the `1` he had earned. Her
    // register showed one person as two, one of them a first-contact stranger — and because
    // §6.5's budget keys on the level, his next proposal was subject to the level-0 cap.
    // Recovering your key made you spam-suspect to the people who know you best.
    expect(a.node.verificationLevel(a.persona.personaId, boyan.personaId)).toBe('1');
    expect(a.node.verificationLevel(a.persona.personaId, boyanNext.personaId)).toBe('1');
  });

  it('but a stranger is still a stranger, and a rotation nobody told me about carries nothing', () => {
    // The control, in two halves. Continuity must not become "everyone is level 1", and it must
    // travel only on a rotation THIS vault accepted — §1.7 continuity is a statement Ana holds,
    // not a property of the key.
    expect(a.node.verificationLevel(a.persona.personaId, stranger.personaId)).toBe('0');
    const unheard = track(twoPeople([['ana2', 0]], people.clock.iso()));
    expect(
      unheard.sides[0]!.node.verificationLevel(unheard.sides[0]!.persona.personaId, boyanNext.personaId),
    ).toBe('0');
  });
});

describe('what the person being promised to can actually read', () => {
  let people: TwoPeople;
  let a: TwoPeople['sides'][number];
  let b: TwoPeople['sides'][number];
  let plain: string;
  let mistaken: string;

  beforeAll(async () => {
    people = track(
      twoPeople(
        [
          ['ana', 0],
          ['boyan', 1],
        ],
        START,
      ),
    );
    [a, b] = people.sides as [typeof a, typeof b];
    plain = promise(a, b.persona.personaId, 'pull the staging data by Wednesday', '2026-03-04T17:00:00Z');
    mistaken = promise(a, b.persona.personaId, 'a promise dismissed by mistake', '2026-03-06T17:00:00Z');
    await settle(people);
  });

  it('is a hash and a notice that the words stayed with their author', () => {
    const mine = a.node.openLoops({ persona: null, view: 'owe', limit: 10 }).items.find((i) => i.id === plain)!;
    const theirs = b.node.openLoops({ persona: null, view: 'waiting', limit: 10 }).items.find((i) => i.id === plain)!;

    expect(mine.intent_or_expect).toBe('pull the staging data by Wednesday');

    // M-7 is a conformance MUST — "plaintext never appears in wire objects" — and `ProposePayload`
    // is `{edge, assertion}`, so Boyan not having the words is the protocol working. What was
    // broken was the screen: he was shown the string the node uses for "M-15 retention DELETED
    // this", with `confirm` beside it, so the ordinary first-contact case read as destroyed data.
    // The two causes have their own sentences now, chosen from `plaintext_deleted_at` rather
    // than guessed from a role.
    expect(theirs.intent_or_expect).toBe('(the words stayed with the person who wrote them)');
    expect(theirs.actions.map((x) => x.act)).toEqual(['confirm', 'dismiss']);

    // There is also nowhere for him to record what HE believes was promised, so two people who
    // remember it differently have the same screen as two people who agree.
    expect(b.vault.getCommitment(b.persona.personaId, plain)).toBeNull();
  });

  it('and dismissing then confirming leaves him with no screen at all — REPORTED', async () => {
    b.node.confirm({ id: mistaken, decision: 'dismiss' });
    // §6.5 is right that dismissal signs nothing — a proposed edge is socially nothing.
    expect(b.node.openLoops({ persona: null, view: 'all', limit: 10 }).items.map((i) => i.id)).not.toContain(mistaken);

    // He changes his mind. The acceptance is real, it is signed, and it reaches Ana.
    b.node.confirm({ id: mistaken, decision: 'confirm' });
    await settle(people);
    expect(a.node.edgeState(a.persona.personaId, mistaken).final_state).toBe('open');

    // Was REPORTED: `dismissed` was never cleared, and `itemsFor` drops a dismissed edge from
    // EVERY view unconditionally — so the promise Boyan had just made binding sat on Ana's
    // register as `open` and on Boyan's register nowhere, in any view, for ever. Confirming is
    // the opposite of a shrug, so signing clears the dismissal.
    expect(b.node.edgeState(b.persona.personaId, mistaken).final_state).toBe('open');
    const ids = (view: 'all' | 'waiting') =>
      b.node.openLoops({ persona: null, view, limit: 10 }).items.map((i) => i.id);
    expect(ids('all')).toContain(mistaken);
    // And on the side he is actually on: he is owed this one, so it is in `waiting`, never `owe`.
    expect(ids('waiting')).toContain(mistaken);
    expect(b.node.openLoops({ persona: null, view: 'owe', limit: 10 }).items.map((i) => i.id)).not.toContain(
      mistaken,
    );
  });

  it('and a dismissal a person has not reversed still hides the promise', async () => {
    // The control. Clearing on confirm must not turn dismissal into a no-op — otherwise the fix
    // above would pass by simply never hiding anything.
    const ignored = promise(a, b.persona.personaId, 'a promise genuinely not wanted', '2026-03-09T17:00:00Z');
    await settle(people);
    b.node.confirm({ id: ignored, decision: 'dismiss' });
    expect(b.node.openLoops({ persona: null, view: 'all', limit: 10 }).items.map((i) => i.id)).not.toContain(
      ignored,
    );
  });
});

/**
 * The node surface is not the screen. `@servanda/client-web` builds the ledger the TUI and the web
 * app both render, from one `open_loops({view:'all'})` and one `brief` — so these are the words and
 * the columns two real people read, not an intermediate shape.
 */
describe('the two screens, as the shipped client builds them', () => {
  let people: TwoPeople;
  let sides: [TwoPeople['sides'][number], TwoPeople['sides'][number]];
  let edge: string;
  let mine: LedgerView;
  let theirs: LedgerView;
  let contested: LedgerView;

  // The three views `loadApp` now asks for, from this side's own node — so this is the same
  // input the shipped ledger receives. It used to be one `view: 'all'` call that the client
  // re-bucketed by `kind`, which is what put a promise made TO you under "You owe".
  const ledgerOf = (side: TwoPeople['sides'][number], at: string): LedgerView =>
    buildLedger(
      {
        owe: side.node.openLoops({ view: 'owe', persona: null, limit: 100 }),
        waiting: side.node.openLoops({ view: 'waiting', persona: null, limit: 100 }),
        closed: side.node.openLoops({ view: 'closed', persona: null, limit: 100 }),
      },
      at,
    );

  beforeAll(async () => {
    people = track(
      twoPeople(
        [
          ['ana', 0],
          ['boyan', 1],
        ],
        START,
      ),
    );
    sides = people.sides as typeof sides;
    const [a, b] = sides;
    edge = promise(a, b.persona.personaId, 'ship the migration', '2026-03-06T17:00:00Z');
    await settle(people);
    b.node.confirm({ id: edge, decision: 'confirm' });
    await settle(people);

    mine = ledgerOf(a, people.clock.iso());
    theirs = ledgerOf(b, people.clock.iso());

    // Partitioned. Ana closes with evidence; Boyan lets her off. Neither has seen the other.
    people.clock.advanceDays(3);
    expect(a.node.act(ActInput.parse({ id: edge, act: 'done', evidence_hash: EVIDENCE })).accepted).toBe(true);
    expect(b.node.act(ActInput.parse({ id: edge, act: 'release' })).accepted).toBe(true);
    await settle(people);
    contested = ledgerOf(a, people.clock.iso());
  });

  const section = (view: LedgerView, id: string) => view.sections.find((s) => s.id === id)!;

  it('converges on one chain when we both act at the same moment', () => {
    // What held, and it is the whole point of §4.4's `contested-closure`: two honest nodes, two
    // legal acts, one chain. Nothing signed was discarded and the two sides agree.
    for (const side of sides) {
      expect(side.node.edgeState(side.persona.personaId, edge).final_state).toBe('contested-closure');
      expect(side.vault.getAssertions(side.persona.personaId, edge).map((x) => x.state).sort()).toEqual([
        'closed',
        'confirmed',
        'proposed',
        'released',
      ]);
    }
  });

  it('and the node keeps that live disagreement live, on the side each person is on', () => {
    // Was REPORTED: `contested-closure` was missing from the node's `live` set, so it fell to
    // `view: 'closed'` and both people were told a live disagreement had finished — while
    // `disputed`, which has the identical "both parties or not at all" shape, sat in `owe` and
    // `waiting` where it belongs. §4.3 leaves three exits open here.
    //
    // Each side sees it under their OWN role: the owner owes it, the counterparty is waiting on
    // it. The state is shared; which column it sits in is not.
    const [a, b] = sides;
    const view = (side: typeof a, v: 'owe' | 'waiting' | 'closed') =>
      side.node.openLoops({ persona: null, view: v, limit: 10 }).items;

    expect(view(a, 'owe').map((i) => i.state)).toEqual(['contested-closure']);
    expect(view(a, 'waiting')).toHaveLength(0);
    expect(view(b, 'waiting').map((i) => i.state)).toEqual(['contested-closure']);
    expect(view(b, 'owe')).toHaveLength(0);
    for (const side of sides) expect(view(side, 'closed')).toHaveLength(0);
  });

  it('and offers the one exit that is honestly reachable, to both of them', () => {
    // `supersede` and nothing else, which is exactly `disputed`'s answer and for the same
    // reason (§7/#41): the two joint exits need BOTH halves, and `act` binds `done` to the owner
    // alone, so the counterparty has no advertised way to sign theirs. Advertising `done` to the
    // owner would record a closure that can never complete — the failure M-20 exists to prevent.
    for (const side of sides) {
      const items = [
        ...side.node.openLoops({ persona: null, view: 'owe', limit: 10 }).items,
        ...side.node.openLoops({ persona: null, view: 'waiting', limit: 10 }).items,
      ];
      expect(items).toHaveLength(1);
      expect(items[0]!.actions.map((x) => x.act)).toEqual(['supersede']);
    }
    // And `done` is refused if a client signs it anyway, rather than recording a half-closure.
    const [a] = sides;
    expect(a.node.act({ id: edge, act: 'done', evidence_hash: 'f'.repeat(64) })).toMatchObject({
      accepted: false,
      rejection_reason: 'illegal-source-state',
    });
  });

  it('puts the promise under "You owe" for the person who made it', () => {
    expect(section(mine, 'owe').cards.map((c) => c.what)).toEqual(['ship the migration']);
    expect(section(mine, 'waiting').cards).toHaveLength(0);
  });

  it('and under "You are waiting" for the person it was made TO', () => {
    // Was REPORTED, and it is the worst thing this pass found. `buildLedger` bucketed by
    // `isWaiting`, which was `item.kind === 'expectation'` — and an edge is `kind: 'edge'` for
    // BOTH parties, so nothing in the ledger ever read the role. The person who is OWED the
    // promise was told they owed it, with `Let it go` — release, the act of the party who is
    // owed — sitting under that heading. The client now asks the node for `view: 'waiting'`
    // instead of re-deriving an answer the node already has.
    expect(section(theirs, 'owe').cards).toHaveLength(0);
    expect(section(theirs, 'waiting').cards).toHaveLength(1);
    // The control was always right; only the column was wrong.
    expect(section(theirs, 'waiting').cards[0]!.actions.map((x) => x.label)).toContain('Let it go');
    // And what he is asked to sign now says why he cannot read it, rather than claiming it was
    // erased. Still REPORTED, and unchanged: there is nowhere for him to record what HE believes
    // was promised, so two people who remember it differently see the same screen as two who agree.
    expect(section(theirs, 'waiting').cards[0]!.what).toBe('(the words stayed with the person who wrote them)');
  });

  it('and the client says what happened, instead of reading a date that no longer governs', () => {
    // Was REPORTED, three ways at once. The client's own `CLOSED_STATES` omitted
    // `contested-closure` so it landed under "You owe" while the node's `view: 'owe'` returned
    // nothing for it — the two §7 read tools disagreeing about one state. `consequenceFor`
    // settled only on closed/released/expired, so it fell through to date arithmetic and told
    // Ana she had a day left to do a thing she had closed with evidence three days ago. And
    // `COPY.chain` named every EffectiveState but this one.
    //
    // Both surfaces take the answer from the node now, and the state has words.
    const card = section(contested, 'owe').cards[0]!;
    expect(card.ifIDoNothing).toBe(COPY.consequence.contested);
    expect(card.ifIDoNothing).not.toMatch(/^Due /);
    expect(card.tone).toBe('passed');
    expect(card.actions.map((a) => a.label)).toEqual([COPY.actions.supersede]);
    expect(Object.keys(COPY.chain)).toContain('contested-closure');
  });
});

describe('one of us is on a shared repository and the other is on a hub', () => {
  it('nothing arrives, and nothing on either screen says so — REPORTED', async () => {
    let people: TwoPeople;
    const now = (): Date => people.clock.now();
    const hub = new MemoryHub({ baseUrl: HUB, now });
    const resolve = dhDirectory([ana, boyan], { now });
    people = track(
      twoPeople(
        [
          ['ana', 0],
          ['boyan', 1],
        ],
        START,
        {
          transportFor: ({ who }) =>
            who === 'boyan'
              ? hubTransport({ hub, baseUrl: HUB, persona: boyan, resolveDhKey: resolve, now })
              : null,
        },
      ),
    );
    const [a, b] = people.sides;
    const edge = promise(a!, b!.persona.personaId, 'a promise across two transports', '2026-03-20T17:00:00Z');

    // Ana's push succeeds — she wrote to her shared repository, which is exactly what her node
    // was configured to do — and Boyan's pull is empty, because he was never on it.
    expect(await a!.fed.push()).toBe(1);
    const got = await b!.fed.pull();
    expect(got.accepted).toEqual([]);
    expect(got.discarded).toEqual([]);

    // REPORTED — `FederatedNode` binds ONE transport for all counterparties, and §6.7 makes the
    // medium a property of the RECIPIENT: a persona declares its hubs, or is reachable only over
    // a repository. Nothing resolves a counterparty to the medium they declared, nothing refuses
    // an unroutable send, and neither register carries the fact. Ana reads `proposed` and Boyan
    // reads an empty list — the same two screens as a promise that was delivered and ignored.
    expect(a!.node.edgeState(a!.persona.personaId, edge).final_state).toBe('proposed');
    expect(b!.node.openLoops({ persona: null, view: 'all', limit: 10 }).items).toHaveLength(0);
  });
});
