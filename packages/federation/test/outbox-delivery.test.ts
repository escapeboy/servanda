import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@servanda/types';
import { hashCanonical } from '@servanda/crypto';
import type { WireMessage } from '@servanda/types';
import { FederatedNode, OutboundDeliveryError } from '../src/federated-node.js';
import { signMessage } from '../src/messages.js';
import type { Transport } from '../src/transport.js';
import { makePair, makeSolo, persona, settle, type Pair, type Solo } from './support/fixture.js';

/**
 * The outbound half of §6.7, which had no state at all.
 *
 * Three separate defects meet in `push`, and they are separable:
 *
 *  1. **No delivery state.** An `OutboxItem` was `{id, recipient, message, queued_at}`. A message
 *     nobody could address and a message a counterparty was ignoring were the same four fields,
 *     so a person waiting a year could not tell which they were living in.
 *  2. **All-or-nothing.** The loop threw from inside itself on the first refusal, so healthy
 *     counterparties queued behind an unreachable one never heard anything — and `sync()` was
 *     skipped too, so even the messages already staged for a git push stayed in a local clone.
 *  3. **No route.** One node spoke exactly one transport, so a person on a shared repository and
 *     a person on a hub could not reach each other however correct both nodes were.
 *
 * The cases below are deliberately synthetic: one vault, hand-built wire messages, fake couriers.
 * Two vaults and two git clones would prove the same three things far more slowly, and the story
 * that needs real nodes has one — `packages/e2e/test/scenario-8-crossed-transports.test.ts`.
 */

const NOW = new Date('2026-07-25T09:00:00.000Z');

/** A courier that refuses whoever it is told to, and remembers everything it was asked. */
class FakeCourier implements Transport {
  readonly kind = 'hub' as const;
  readonly attempted: string[] = [];
  readonly accepted: string[] = [];
  readonly carried: WireMessage[] = [];
  syncs = 0;

  constructor(private readonly refusal: (recipient: string, message: WireMessage) => string | null) {}

  async send(recipient: string, message: WireMessage): Promise<void> {
    this.attempted.push(recipient);
    const why = this.refusal(recipient, message);
    if (why !== null) throw new Error(why);
    this.accepted.push(recipient);
    this.carried.push(message);
  }

  async receive(): Promise<WireMessage[]> {
    return [];
  }

  async sync(): Promise<void> {
    this.syncs++;
  }
}

const unreachable = persona(1).personaId;
const reachable = persona(2).personaId;

/** Every assertion signature a courier actually carried, wherever it rode. */
function sentSigs(courier: FakeCourier): string[] {
  return courier.carried
    .map((m) => (m.payload as { assertion?: { sig?: string } } | null)?.assertion?.sig)
    .filter((sig): sig is string => typeof sig === 'string');
}

/**
 * Queue a message under the id §6.2 says it has: the digest of the message.
 *
 * This used to take a CHOSEN id, because `listOutbox` returns items in filename order and the
 * whole point of the starvation case is what happens to the items BEHIND a failure — so which one
 * came first could not be left to a hash. That worked only because `putOutbox` did not enforce
 * the binding `queuePropose` already maintained, and this test's own comment said so.
 *
 * The binding is enforced now, so the order is no longer chosen. It is DISCOVERED: queue both,
 * read the order back, and make whichever sorts first the unreachable one. The property under
 * test — a failure does not starve what is behind it — never depended on which recipient that
 * was, only on there being one behind the other.
 */
function build(solo: Solo, recipient: string, edgeId: string): { message: WireMessage; id: string } {
  const message = signMessage(
    'propose',
    { edge: { edge_id: edgeId }, assertion: null },
    solo.personaId,
    recipient,
    NOW.toISOString(),
    solo.privateKey,
  );
  return { message, id: hashCanonical(message as unknown as Record<string, unknown>) };
}

function store(solo: Solo, recipient: string, built: { message: WireMessage; id: string }): string {
  solo.vault.putOutbox({
    v: PROTOCOL_VERSION,
    type: 'outbox_item',
    id: built.id,
    persona: solo.personaId,
    recipient,
    message: built.message as unknown as Record<string, unknown>,
    queued_at: NOW.toISOString(),
  });
  return built.id;
}

/**
 * Queue two messages so that `first` is genuinely ahead of `second` in `listOutbox`.
 *
 * `listOutbox` is filename order and filenames are ids, so with §6.2's binding enforced the order
 * follows the digest and cannot be dictated. It CAN be searched for: vary the edge id until the
 * two digests fall the right way. Deterministic, no hand-picked hashes, and — the reason it is a
 * named helper rather than a fixture — the requirement it encodes is stated out loud. "One bad
 * recipient must not starve the rest" is a claim about what is BEHIND the failure, and a setup
 * that quietly put the healthy one first would pass while proving nothing.
 */
function queueBehind(solo: Solo, first: string, second: string): { first: string; second: string } {
  for (let i = 0; i < 64; i++) {
    const a = build(solo, first, i.toString(16).padStart(64, 'a'));
    const b = build(solo, second, i.toString(16).padStart(64, 'b'));
    // Searched BEFORE anything is written. There is no `dropOutbox`, and adding one so a test
    // could undo its own setup would be the tail wagging the dog — `build` is pure, so the search
    // costs nothing but signatures.
    if (a.id < b.id) return { first: store(solo, first, a), second: store(solo, second, b) };
  }
  throw new Error('could not order two outbox items; the digest is not behaving like a hash');
}

describe('§6.7 outbound — one bad recipient must not starve the rest', () => {
  let solo: Solo;
  let courier: FakeCourier;
  let fed: FederatedNode;

  beforeAll(() => {
    solo = makeSolo(0);
    courier = new FakeCourier((r) => (r === unreachable ? 'hub refused delivery: HTTP 503' : null));
    fed = new FederatedNode({
      vault: solo.vault,
      persona: solo.personaId,
      transport: courier,
      now: () => NOW,
    });
    // The unreachable one FIRST. Before the fix this is the item that ended the loop.
    queueBehind(solo, unreachable, reachable);
  });

  afterAll(() => solo?.cleanup());

  it('attempts every recipient, delivers the healthy one, and still reports the failure', async () => {
    const error = await fed.push().then(
      () => null,
      (e: unknown) => e,
    );

    // The starvation itself, asserted FIRST so this case fails on the behaviour rather than on a
    // symbol that did not exist before the fix.
    expect(courier.attempted).toContain(reachable);
    expect(courier.accepted).toEqual([reachable]);
    // …and the medium was still flushed, which the old `push` also skipped on the way out.
    expect(courier.syncs).toBeGreaterThan(0);

    // Throwing is correct and stays correct: a caller that could ignore this by accident is a
    // promise that quietly went nowhere. What changed is WHEN — after everyone has been tried.
    expect(error).toBeInstanceOf(OutboundDeliveryError);
    const failures = (error as OutboundDeliveryError).failures;
    expect(failures.map((f) => f.recipient)).toEqual([unreachable]);
    expect(failures[0]!.reason).toContain('503');
  });

  it('records what is known about each, and refuses to claim more than the courier proved', () => {
    const byRecipient = new Map(fed.outbound().map((s) => [s.recipient, s]));

    const good = byRecipient.get(reachable)!;
    expect(good.state).toBe('sent');
    expect(good.sent_via).toBe('hub');
    expect(good.acknowledged_at).toBeNull();
    // The sentence names the courier and then denies what a person would otherwise read into it.
    expect(good.explanation).toContain('not that');
    expect(good.explanation).toContain('read them');

    const bad = byRecipient.get(unreachable)!;
    expect(bad.state).toBe('queued');
    expect(bad.sent_at).toBeNull();
    expect(bad.attempts).toBeGreaterThan(0);
    expect(bad.last_error).toContain('503');
    // A courier that refused today may work tomorrow — this is not the unroutable sentence.
    expect(bad.explanation).toContain('refused');
  });
});

describe('§6.1 per-recipient routing — a counterparty with no courier is visible, not silent', () => {
  let solo: Solo;
  let fed: FederatedNode;
  const later = new Date('2027-07-25T09:00:00.000Z');
  let clock = NOW;

  beforeAll(() => {
    solo = makeSolo(3);
    const courier = new FakeCourier(() => null);
    fed = new FederatedNode({
      vault: solo.vault,
      persona: solo.personaId,
      transport: courier,
      // This node holds a courier that reaches one person and nothing that reaches the other.
      routeFor: (recipient) => (recipient === reachable ? courier : null),
      now: () => clock,
    });
    queueBehind(solo, unreachable, reachable);
  });

  afterAll(() => solo?.cleanup());

  it('names the unroutable recipient rather than pretending the message is in flight', async () => {
    await expect(fed.push()).rejects.toThrow(OutboundDeliveryError);

    const stranded = fed.outbound().find((s) => s.recipient === unreachable)!;
    expect(stranded.state).toBe('unroutable');
    expect(stranded.sent_at).toBeNull();

    // The whole requirement, in one assertion: a person can learn from this string that the
    // message will never arrive, and why, without opening a source file.
    expect(stranded.explanation).toContain('never left this machine');
    expect(stranded.explanation).toContain('will not arrive until a transport');

    // …while the person who DOES have a courier was not starved by the one who does not.
    expect(fed.outbound().find((s) => s.recipient === reachable)!.state).toBe('sent');
  });

  it('counts the wait from when the address went missing, not from the last futile attempt', async () => {
    clock = later;
    await expect(fed.push()).rejects.toThrow(OutboundDeliveryError);

    const stranded = fed.outbound().find((s) => s.recipient === unreachable)!;
    expect(stranded.explanation).toMatch(/for 36[0-9] day\(s\)/);
    expect(stranded.attempts).toBeGreaterThan(1);
  });
});

/**
 * The same defect `emit` already carries a paragraph about, one loop further down.
 *
 * `emit` was corrected to mark a message sent only once the transport ACCEPTED it. The assertion
 * loop below it still marked `sentAssertions` BEFORE calling `emit`, so a hub that answered 503
 * retired the assertion for the life of the process: the counterparty never learned this side had
 * closed, and no later `push` would ever tell them. §6.4 recon would eventually heal it, which is
 * why this is a delivery bug rather than a correctness one — but §6.7 is explicit that recon is
 * the expensive half, and it is not supposed to be carrying traffic a five-minute outage dropped.
 */
describe('§6.7 — an assertion a courier refused is not retired', () => {
  let pair: Pair;
  let edge: string;
  let refusing = true;
  let courier: FakeCourier;
  let restarted: FederatedNode;
  let mine: string[];

  beforeAll(async () => {
    pair = makePair();
    edge = pair.a.node.commit({
      intent: 'the thing I said I would do',
      owed_to: pair.b.personaId,
      due: '2026-08-01T17:00:00Z',
      propose: true,
      persona: null,
    }).edge_id!;
    await settle(pair, 1);
    pair.b.node.confirm({ id: edge, decision: 'confirm' });
    await settle(pair, 1);
    pair.a.node.act({ id: edge, act: 'done', evidence_hash: 'e'.repeat(64) });

    mine = pair.a.vault
      .getAssertions(pair.a.personaId, edge)
      .filter((x) => x.by === pair.a.personaId)
      .map((x) => x.sig);

    // The courier refuses ASSERTIONS only. It has to accept the queued `propose` first, because
    // otherwise the old `push` died in the outbox loop and never reached the loop under test —
    // and a case that cannot reach the defect proves nothing about having fixed it.
    courier = new FakeCourier((_r, message) =>
      refusing && message.type === 'assert' ? 'hub refused delivery: HTTP 503' : null,
    );
    restarted = new FederatedNode({
      vault: pair.a.vault,
      persona: pair.a.personaId,
      transport: courier,
      now: () => pair.now,
    });
  }, 180_000);

  afterAll(() => pair?.cleanup());

  it('is re-presented on the next push once the courier is back', async () => {
    expect(mine.length).toBeGreaterThan(1);

    refusing = true;
    await expect(restarted.push()).rejects.toThrow(OutboundDeliveryError);
    // Nothing signed as an `assert` got through the outage — which is the courier's doing and is
    // not itself the defect. The defect is what the NEXT push does about it.
    expect(sentSigs(courier)).not.toContain(mine[mine.length - 1]);

    refusing = false;
    await restarted.push().catch(() => undefined);

    // EVERY assertion this side signed reaches the counterparty, not just the ones that happened
    // to sit after the first refusal in the loop.
    for (const sig of mine) expect(sentSigs(courier)).toContain(sig);
  });
});
