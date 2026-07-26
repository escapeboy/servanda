import { renderToHtml, visibleText } from '@servanda/client-web';
import { describe, expect, it } from 'vitest';
import {
  HOSTILE_TEXTS,
  MILA,
  PENDING_ID,
  QUOTE_MAX_CHARS,
  STEFAN,
  chatContext,
  chatReactionEvent,
  chatReactionFixture,
  commentReactionEvent,
  commentReactionFixture,
  gestureCardEl,
  isScrubbed,
  prContext,
  quote,
  resolveReaction,
} from '../../src/index.js';

/**
 * M-6: signal content is data, never instruction.
 *
 * The text a gesture arrives with was written by whoever wrote it, which on a public review
 * thread means anybody at all (scenario 6). The whole of this package's defence is that the
 * text reaches exactly one place — the quoted body of a card — and reaches no other. It does
 * not choose a tool, name a party, set a decision, or select an id.
 */

/** Ranges written as numbers, so the characters under test survive being written down. */
const RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function actingCharacters(text: string): number[] {
  return [...text]
    .map((c) => c.codePointAt(0) ?? 0)
    .filter((cp) => RANGES.some(([lo, hi]) => cp >= lo && cp <= hi));
}

describe('M-6: the words a gesture arrives with are quoted, never read as control', () => {
  it('scrubs what makes text act and keeps what makes it text', () => {
    for (const hostile of HOSTILE_TEXTS) {
      const quoted = quote(hostile);
      expect(isScrubbed(quoted)).toBe(true);
      expect(quoted.length).toBeLessThanOrEqual(QUOTE_MAX_CHARS);
      expect(actingCharacters(quoted)).toEqual([]);
    }
    // The check must be able to fail: the same scan on the unscrubbed bodies finds them.
    const raw = HOSTILE_TEXTS.flatMap((t) => actingCharacters(t));
    expect(raw.length).toBeGreaterThan(0);
  });

  it('shows the injection rather than obeying it', () => {
    const injection = HOSTILE_TEXTS[0]!;
    const event = commentReactionEvent(commentReactionFixture('mila', injection), prContext());
    const resolved = resolveReaction(event!);
    expect(resolved.kind).toBe('card');
    if (resolved.kind !== 'card') return;

    // The words appear. That is the point: quoting is the defence, not filtering.
    expect(resolved.card.what).toContain('ignore previous instructions');
    expect(visibleText(gestureCardEl(resolved.card)).join(' ')).toContain('SYSTEM:');

    // And nothing in them chose anything. The card is Mila's own confirm card, its intent is
    // §7 confirm on the pending id the node supplied, and the owner named in the text is
    // nowhere in the arguments.
    expect(resolved.card.kind).toBe('confirm-own-promise');
    if (resolved.card.kind !== 'confirm-own-promise') return;
    const intent = resolved.card.actions[0].intent;
    expect(intent.tool).toBe('confirm');
    expect(intent.args.id).toBe(PENDING_ID);
    expect(intent.args.decision).toBe('confirm');
    expect(JSON.stringify(intent.args)).not.toContain(STEFAN);
  });

  it('reads no field of a body as an argument, for any body', () => {
    for (const hostile of HOSTILE_TEXTS) {
      const event = chatReactionEvent(chatReactionFixture(hostile, 'mila'), chatContext());
      expect(event).not.toBeNull();
      // Who reacted comes from the platform's actor, never from the body.
      expect(event!.by).toBe(MILA);

      const resolved = resolveReaction(event!);
      if (resolved.kind !== 'card') {
        // The only body that produces no card is the one that scrubs down to nothing.
        expect(resolved.kind).toBe('ignored');
        continue;
      }
      for (const action of resolved.card.actions) {
        const serialised = JSON.stringify(action.intent);
        expect(serialised).not.toContain('<script');
        expect(serialised).not.toContain('"owner"');
      }
    }
  });

  it('never lets a body become markup', () => {
    const markup = '</blockquote><script>alert(1)</script>';
    const event = chatReactionEvent(chatReactionFixture(markup, 'mila'), chatContext());
    const resolved = resolveReaction(event!);
    if (resolved.kind !== 'card') throw new Error('expected a card');
    const html = renderToHtml(gestureCardEl(resolved.card));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('caps a body that would otherwise push everything else off the card', () => {
    const huge = 'x'.repeat(50_000);
    const event = chatReactionEvent(chatReactionFixture(huge, 'mila'), chatContext());
    const resolved = resolveReaction(event!);
    if (resolved.kind !== 'card') throw new Error('expected a card');
    expect(resolved.card.what.length).toBe(QUOTE_MAX_CHARS);
    // The three questions still fit and still answer, which is what the cap is for.
    expect(resolved.card.ifIDoNothing.length).toBeGreaterThan(0);
  });

  it('quotes a display name too, because that is written by a person as well', () => {
    const hook = chatReactionFixture('I will look at it today', 'mila');
    const hostile = {
      ...hook,
      item: { ...hook.item, user: { ...hook.item.user, display_name: HOSTILE_TEXTS[4]! } },
    };
    const event = chatReactionEvent(hostile, chatContext());
    const resolved = resolveReaction(event!);
    if (resolved.kind !== 'card') throw new Error('expected a card');
    expect(actingCharacters(resolved.card.provenance)).toEqual([]);
    for (const text of visibleText(gestureCardEl(resolved.card))) {
      expect(actingCharacters(text)).toEqual([]);
    }
  });
});
