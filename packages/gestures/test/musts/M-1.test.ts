import { describe, expect, it } from 'vitest';
import {
  MILA,
  STEFAN,
  asOwn,
  commentReactionEvent,
  commentReactionFixture,
  chatContext,
  chatReactionEvent,
  chatReactionFixture,
  everyCard,
  fixtureDirectory,
  meetingEndCards,
  meetingFixture,
  prContext,
  quote,
  resolveReaction,
  utteranceFixture,
} from '../../src/index.js';

/**
 * M-1: a promise is owned by its giver. No gesture may create a commitment whose owner is
 * not the person making the gesture. "They said they would" is an expectation, never a
 * proposal on their behalf.
 *
 * The design claim being tested is stronger than "the check works": the illegal case is
 * unrepresentable. `confirmCard` and `recordCard` accept `OwnUtterance`, whose only
 * constructor is `asOwn`, which returns null unless the speaker is the confirming person.
 * There is no runtime branch that decides to refuse, so what these tests prove is that no
 * path *reaches* one — and gate GL adds the compile-time half by requiring that a file
 * calling `confirmCard` on somebody else's words fails to typecheck.
 */
describe('M-1: a gesture may confirm your own promise and may never assert somebody else’s', () => {
  it('refuses to call somebody else’s words mine', () => {
    const theirs = utteranceFixture({
      speaker: {
        display: quote('stefan'),
        externalId: 'chat:U-4102',
        personaId: STEFAN,
        verification: '3',
      },
    });
    expect(asOwn(theirs, MILA)).toBeNull();
    // Nor is an unresolvable speaker mine by default.
    expect(asOwn(utteranceFixture({ speaker: { ...theirs.speaker, personaId: null } }), MILA)).toBeNull();
  });

  it('turns a gesture on somebody else’s promise into an expectation, not a proposal', () => {
    const hook = chatReactionFixture('I will send the schema by Thursday', 'stefan');
    const event = chatReactionEvent(hook, chatContext());
    expect(event).not.toBeNull();

    const resolved = resolveReaction(event!);
    expect(resolved.kind).toBe('card');
    if (resolved.kind !== 'card') return;

    expect(resolved.card.kind).toBe('note-expectation');
    const intent = resolved.card.actions[0].intent;
    expect(intent.kind).toBe('tool');
    if (intent.kind !== 'tool') return;
    expect(intent.tool).toBe('expect');
    // An expectation names who you are waiting on; it does not claim to be their record.
    expect(JSON.stringify(intent.args)).not.toContain('propose');
  });

  it('never emits commit or an accepting confirm from anyone but the speaker', () => {
    const attempts = [
      // Stefan taps the handshake on Mila's promise.
      commentReactionEvent(commentReactionFixture('stefan'), prContext()),
      // Somebody taps it on Stefan's words in chat.
      chatReactionEvent(chatReactionFixture('I will send the schema', 'stefan'), chatContext()),
    ];
    for (const event of attempts) {
      expect(event).not.toBeNull();
      const resolved = resolveReaction(event!);
      if (resolved.kind !== 'card') continue;
      for (const action of resolved.card.actions) {
        const intent = action.intent;
        if (intent.kind !== 'tool') continue;
        expect(intent.tool).not.toBe('commit');
        if (intent.tool === 'confirm') {
          // The only confirm available on somebody else's words is a dismissal of your own
          // queue item — which asserts nothing about them.
          expect(intent.args.decision).toBe('dismiss');
        }
      }
    }
  });

  it('gives a commit intent no way to name an owner', () => {
    const [confirm, record] = everyCard();
    expect(record?.kind).toBe('record-own-promise');
    const intent = record!.actions[0].intent;
    if (intent.kind !== 'tool' || intent.tool !== 'commit') throw new Error('expected a commit');
    // §7: `commit` with an owner other than the caller's own is invalid. The input has no
    // owner field at all, and persona is pinned to the active one rather than taken from a
    // payload — so a payload cannot reach it.
    expect(intent.args.persona).toBeNull();
    expect(Object.keys(intent.args)).not.toContain('owner');
    expect(confirm?.kind).toBe('confirm-own-promise');
  });

  it('holds across a whole meeting, item by item', () => {
    const payload = meetingFixture();
    const cards = meetingEndCards(payload, fixtureDirectory(), MILA);
    expect(cards).toHaveLength(3);
    // Mila's own item is hers to confirm; Stefan's and the unattributed one are not.
    expect(cards.map((c) => c.kind)).toEqual([
      'confirm-own-promise',
      'note-expectation',
      'note-expectation',
    ]);
    for (const card of cards.slice(1)) {
      for (const action of card.actions) {
        if (action.intent.kind !== 'tool') continue;
        expect(action.intent.tool).not.toBe('commit');
      }
    }
  });
});
