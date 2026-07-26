import { COPY, focusOrder, pointerOnlyControls, visibleText, walk } from '@servanda/client-web';
import { describe, expect, it } from 'vitest';
import {
  AT_MEETING_END,
  CONFIRM_REACTION,
  MILA,
  NO_POSTER,
  PENDING_ID,
  UNMAPPED_ACTIONS,
  UNMAPPED_REACTIONS,
  chatContext,
  chatReactionEvent,
  chatReactionFixture,
  commentReactionEvent,
  commentReactionFixture,
  deliver,
  everyCard,
  fixtureDirectory,
  gestureCardEl,
  meetingEndCards,
  meetingFixture,
  prContext,
  primaryAction,
  resolveReaction,
  threeQuestions,
  whenTheOtherHalfArrives,
} from '../src/index.js';
import type { CardPlacement } from '../src/index.js';

describe('the confirm card answers the three questions, with the action leading', () => {
  it('answers what, with whom, and what happens if I do nothing', () => {
    for (const card of everyCard()) {
      const answers = threeQuestions(card);
      expect(answers.what.length).toBeGreaterThan(0);
      expect(answers.withWhom.length).toBeGreaterThan(0);
      expect(answers.ifIDoNothing.length).toBeGreaterThan(0);
      // The consequence is a state, never a verdict about a person.
      expect(answers.ifIDoNothing).toMatch(/Nothing is recorded/u);
    }
  });

  it('puts the primary action first, before any of the three answers', () => {
    for (const card of everyCard()) {
      const nodes = walk(gestureCardEl(card));
      const firstButton = nodes.findIndex((n) => n.tag === 'button');
      const answers = [
        nodes.findIndex((n) => n.text === card.what),
        nodes.findIndex((n) => n.text === card.ifIDoNothing),
      ];
      expect(firstButton).toBeGreaterThanOrEqual(0);
      for (const at of answers) {
        expect(at).toBeGreaterThan(firstButton);
      }
      expect(primaryAction(card).primary).toBe(true);
      expect(nodes[firstButton]?.text).toBe(primaryAction(card).label);
    }
  });

  it('is operable without a pointer', () => {
    for (const card of everyCard()) {
      const tree = gestureCardEl(card);
      expect(pointerOnlyControls(tree)).toHaveLength(0);
      const stops = focusOrder(tree);
      expect(stops).toHaveLength(card.actions.length);
      for (const stop of stops) expect(stop.name.length).toBeGreaterThan(0);
    }
  });
});

describe('reaction-confirm', () => {
  it('turns a handshake on your own words into a confirm card', () => {
    const event = commentReactionEvent(commentReactionFixture('mila'), prContext());
    expect(event).not.toBeNull();
    const resolved = resolveReaction(event!);
    if (resolved.kind !== 'card') throw new Error('expected a card');
    expect(resolved.card.kind).toBe('confirm-own-promise');
    expect(resolved.card.place).toBe('pr-comment');
    expect(resolved.card.actions.map((a) => a.label)).toEqual([
      COPY.actions.confirm,
      COPY.actions.dismiss,
    ]);
  });

  it('makes both taps labels — the dismissal is data, not a discarded event (ADR-0012)', () => {
    const event = chatReactionEvent(chatReactionFixture(), chatContext());
    const resolved = resolveReaction(event!);
    if (resolved.kind !== 'card' || resolved.card.kind !== 'confirm-own-promise') {
      throw new Error('expected a confirm card');
    }
    const [confirm, dismiss] = resolved.card.actions;
    expect(confirm.intent.flywheel.decision).toBe('confirm');
    expect(dismiss.intent.flywheel.decision).toBe('dismiss');
    for (const action of resolved.card.actions) {
      expect(action.intent.flywheel.item).toBe(PENDING_ID);
      expect(action.intent.flywheel.place).toBe('chat');
      // A label is a decision, a place and a moment. Never content.
      expect(JSON.stringify(action.intent.flywheel)).not.toContain('pricing');
    }
  });

  it('captures rather than confirms when nothing is pending', () => {
    const event = chatReactionEvent(chatReactionFixture(), chatContext(null));
    const resolved = resolveReaction(event!);
    if (resolved.kind !== 'card' || resolved.card.kind !== 'record-own-promise') {
      throw new Error('expected a record card');
    }
    const intent = resolved.card.actions[0].intent;
    expect(intent.tool).toBe('commit');
    expect(intent.args.propose).toBe(true);
  });

  it('ignores a reaction that is not a gesture', () => {
    const hook = { ...chatReactionFixture(), reaction: 'tada' };
    const resolved = resolveReaction(chatReactionEvent(hook, chatContext())!);
    expect(resolved).toEqual({ kind: 'ignored', reason: 'not-a-gesture' });
  });

  it('cannot be attributed to somebody this node does not know', () => {
    const hook = chatReactionFixture();
    const stranger = { ...hook, user: { id: 'U-0000', display_name: 'nobody' } };
    expect(chatReactionEvent(stranger, chatContext())).toBeNull();
  });

  it('is a pure function of its argument', () => {
    const event = chatReactionEvent(chatReactionFixture(), chatContext())!;
    expect(JSON.stringify(resolveReaction(event))).toBe(JSON.stringify(resolveReaction(event)));
  });
});

describe('actions the node surface names no tool for (upstream issue #19)', () => {
  it('emits a typed unmapped intent rather than inventing a tool name', () => {
    for (const [reaction, action] of Object.entries(UNMAPPED_REACTIONS)) {
      const hook = { ...chatReactionFixture(), reaction };
      const resolved = resolveReaction(chatReactionEvent(hook, chatContext())!);
      expect(resolved.kind).toBe('unmapped');
      if (resolved.kind !== 'unmapped') continue;
      expect(resolved.intent.action).toBe(action);
      expect(resolved.intent.because).toContain('names no tool');
      expect(UNMAPPED_ACTIONS).toContain(action);
      expect(resolved.intent).not.toHaveProperty('tool');
    }
  });

  it('never names a tool outside the five', () => {
    const tools = new Set<string>();
    for (const card of [...everyCard(), ...meetingEndCards(meetingFixture(), fixtureDirectory(), MILA)]) {
      for (const action of card.actions) {
        if (action.intent.kind === 'tool') tools.add(action.intent.tool);
      }
    }
    expect([...tools].sort()).toEqual(['commit', 'confirm', 'expect']);
  });
});

describe('the meeting-end card is the same card at a different moment', () => {
  it('is built by the same builders and differs only in delivery', () => {
    const cards = meetingEndCards(meetingFixture(), fixtureDirectory(), MILA);
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.delivery).toEqual(AT_MEETING_END);
      expect(card.place).toBe('meeting');
      const answers = threeQuestions(card);
      expect(answers.what.length).toBeGreaterThan(0);
      expect(answers.ifIDoNothing.length).toBeGreaterThan(0);
    }
    expect(visibleText(gestureCardEl(cards[0]!))).toContain('Send the revised quote by Friday');
  });
});

describe('two taps from two people, neither of them an interruption', () => {
  it('records the promiser’s half in place and batches the other', () => {
    const resolved = resolveReaction(
      commentReactionEvent(commentReactionFixture('mila'), prContext())!,
    );
    if (resolved.kind !== 'card') throw new Error('expected a card');
    expect(resolved.card.delivery).toEqual({ moment: 'in-situ', interrupts: false });
    expect(whenTheOtherHalfArrives()).toEqual({ moment: 'batched', interrupts: false });
  });

  it('hands the card to an injected poster and nowhere else', async () => {
    const posted: CardPlacement[] = [];
    const card = everyCard()[0]!;
    const placement = await deliver(card, { post: (p) => void posted.push(p) });
    expect(posted).toHaveLength(1);
    expect(placement.ref).toEqual(card.ref);
    // The default poster delivers nowhere, so a missing injection cannot send anything.
    await expect(deliver(card, NO_POSTER)).resolves.toBeDefined();
  });
});

describe('the designated reaction', () => {
  it('is the handshake', () => {
    expect(CONFIRM_REACTION).toBe('🤝');
  });
});
