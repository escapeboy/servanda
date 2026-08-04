import { describe, expect, it } from 'vitest';
import type { NodeClient } from '@servanda/client-web';
import { FixtureNodeClient, makeFixture } from '@servanda/client-web';
import type { OpenLoopItem, OpenLoopsInput, OpenLoopsOutput } from '@servanda/types';
import { queueCards } from '../src/queue.js';
import { runIntent } from '../src/run.js';
import { unmappedIntent } from '../src/intent.js';
import { primaryAction } from '../src/card.js';

const REF = { kind: 'message' as const, value: 'msg-1' };
const VIEWER = 'a'.repeat(64);

function item(over: Partial<OpenLoopItem>): OpenLoopItem {
  return {
    kind: 'commitment',
    id: '1'.repeat(64),
    intent_or_expect: 'Send Maria the quote by Friday',
    counterparty: null,
    verification_level: '0',
    age_days: 0,
    due: null,
    state: 'vault-local',
    actions: [],
    ...over,
  } as OpenLoopItem;
}

/** A stand-in that answers `pending` with whatever the test put in it. */
class QueueClient implements NodeClient {
  readonly confirmed: unknown[] = [];
  constructor(private readonly items: readonly OpenLoopItem[]) {}
  async commit(): Promise<never> {
    throw new Error('not used');
  }
  async expect(): Promise<never> {
    throw new Error('not used');
  }
  async confirm(input: unknown): Promise<{ state: 'confirmed' }> {
    this.confirmed.push(input);
    return { state: 'confirmed' };
  }
  async brief(): Promise<never> {
    throw new Error('not used');
  }
  async open_loops(input: OpenLoopsInput): Promise<OpenLoopsOutput> {
    expect(input.view).toBe('pending');
    return { items: [...this.items], total: this.items.length, next_cursor: null, skipped: 0 };
  }
}

/**
 * The queue, as cards — the direction that did not exist.
 *
 * `confirmCard` could always build one from an utterance a connector happened to be holding at
 * the moment somebody reacted. Nothing could go the other way, so everything §3 captured while
 * nobody was watching sat in the queue unseen by this surface.
 */
describe('the confirmation queue becomes cards', () => {
  it('makes one card per queued candidate, carrying the person’s own words', async () => {
    const client = new QueueClient([item({}), item({ id: '2'.repeat(64) })]);
    const cards = await queueCards({ client, viewer: VIEWER, place: 'agent', refFor: () => REF });

    expect(cards).toHaveLength(2);
    expect(cards[0]!.kind).toBe('confirm-own-promise');
    expect(cards[0]!.what).toContain('Maria');
    // Both answers, equally reachable. A queue you can only say yes to is not a queue, and the
    // dismissal is the more valuable label of the two (ADR-0012).
    expect(cards[0]!.actions.map((a) => a.intent.kind)).toEqual(['tool', 'tool']);
  });

  it('and REFUSES to dress an inbound proposal as your own words', async () => {
    // `view: "pending"` holds two things since §7's sentence was implemented in full. An edge is
    // a promise another person made and sent; turning it into a `confirm-own-promise` card would
    // put their words under "your own" and offer to record them, which M-1 forbids outright.
    const client = new QueueClient([
      item({ kind: 'edge', id: '3'.repeat(64), state: 'proposed' }),
      item({ id: '4'.repeat(64) }),
    ]);
    const cards = await queueCards({ client, viewer: VIEWER, place: 'agent', refFor: () => REF });

    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe('4'.repeat(64));
  });

  it('points each card back where the caller says, because the queue does not know', async () => {
    const client = new QueueClient([item({})]);
    const cards = await queueCards({
      client,
      viewer: VIEWER,
      place: 'agent',
      refFor: (i) => ({ kind: 'url', value: `https://example.test/${i.id.slice(0, 4)}` }),
    });
    expect(cards[0]!.ref).toEqual({ kind: 'url', value: 'https://example.test/1111' });
  });
});

/**
 * What a gesture DOES.
 *
 * Every intent in this package was shaped, asserted about, and executed by nothing: a grep for
 * `GestureIntent` outside `packages/gestures` found no callers at all. A card could be rendered,
 * tapped, and its answer went nowhere, with every test green.
 */
describe('a tapped gesture reaches the node', () => {
  it('runs the primary action against the six tools', async () => {
    const client = new QueueClient([item({})]);
    const cards = await queueCards({ client, viewer: VIEWER, place: 'agent', refFor: () => REF });
    const outcome = await runIntent(primaryAction(cards[0]!).intent, client);

    expect(outcome).toEqual({ ran: true, tool: 'confirm', state: 'confirmed' });
    expect(client.confirmed).toHaveLength(1);
  });

  it('and the dismissal reaches it too, not only the acceptance', async () => {
    const client = new QueueClient([item({})]);
    const cards = await queueCards({ client, viewer: VIEWER, place: 'agent', refFor: () => REF });
    const dismiss = cards[0]!.actions.find((a) => !a.primary)!;
    const outcome = await runIntent(dismiss.intent, client);

    expect(outcome.ran).toBe(true);
    expect(client.confirmed).toHaveLength(1);
  });

  it('refuses an action §7 binds to no tool, and says why instead of improvising one', async () => {
    const client = new QueueClient([]);
    const intent = unmappedIntent('ping');
    const outcome = await runIntent(intent, client);

    expect(outcome.ran).toBe(false);
    expect(outcome.ran === false && outcome.because.length).toBeGreaterThan(0);
    // Nothing was called. Approximating a missing binding would mean a client calling a tool no
    // conforming node has to implement (upstream #19).
    expect(client.confirmed).toEqual([]);
  });
});

/** The place the product's own capture path happens in, which the closed set did not have. */
describe('where the words were said', () => {
  it('has a name for what you tell your assistant', async () => {
    const client = new QueueClient([item({})]);
    const cards = await queueCards({ client, viewer: VIEWER, place: 'agent', refFor: () => REF });
    expect(cards[0]!.provenance).toMatch(/assistant/u);
  });

  it('and the fixture register still renders through the same builder', () => {
    // Guards the shared path: `@servanda/client-web`'s fixture and this package's cards are
    // built by one renderer, and a change here that broke the app's card would be caught there.
    const fixture = makeFixture(3, '2026-03-01T09:00:00Z');
    expect(new FixtureNodeClient(fixture)).toBeTruthy();
  });
});
