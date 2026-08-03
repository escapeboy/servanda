import { describe, expect, it } from 'vitest';
import type { AppView, FixtureState } from '@servanda/client-web';
import { FixtureNodeClient, loadApp, makeFixture } from '@servanda/client-web';
import { frame, frameLines } from '../src/index.js';

/**
 * What a promise is allowed to do to the terminal it is shown in.
 *
 * `@servanda/gestures` worked this out already, in `quote.ts`, and wrote down the reason:
 * "control characters become spaces — a terminal renders some of them as cursor movement,
 * which is how a message repaints a card it does not own." A gesture card arrives from a
 * chat platform, so it scrubs.
 *
 * This surface never did. §7's `OpenLoopItem.intent_or_expect` and `counterparty` are plain
 * `z.string()` — unbounded, unscrubbed — and `frame.ts` interpolates both into lines that go
 * to a real terminal. The words of a promise reach here from a connector, from an extraction,
 * from a counterparty's proposal: every one of those is somebody else's text.
 *
 * The rule this costs is M-12. A card's name and the evidence behind it are one line —
 * `display · trust.label` — and the name comes first. A counterparty who writes `ESC[8m`
 * after their name conceals everything the terminal prints after it, which is exactly the
 * level. The name survives; its evidence does not. That is a display name rendered above its
 * evidence level, achieved with two characters and no forged signature.
 *
 * So the assertion is structural rather than a list of attacks: the terminal receives no
 * control character this renderer did not put there itself. Nothing this surface legitimately
 * shows contains one — the marks are ASCII parentheses and the rule is a box-drawing dash.
 */

const NOW = '2026-03-01T09:00:00Z';

const ch = (code: number): string => String.fromCodePoint(code);
const ESC = ch(0x1b);
const BELL = ch(0x07);
const NEWLINE = ch(0x0a);
const CARRIAGE_RETURN = ch(0x0d);
const RIGHT_TO_LEFT_OVERRIDE = ch(0x202e);

/** Everything after this is invisible in a terminal that honours SGR 8. */
const CONCEAL = `${ESC}[8m`;

const HOSTILE_WHAT = `Send the quote${ESC}[2J${ESC}]0;retitled${BELL}${CARRIAGE_RETURN}`;
const HOSTILE_NAME = `Dana Reyes${CONCEAL}${NEWLINE}${RIGHT_TO_LEFT_OVERRIDE}`;

/** One item, written by somebody who would rather repaint this card than appear on it. */
function hostileState(): FixtureState {
  const base = makeFixture(1, NOW);
  const item = {
    ...(base.items[0] as FixtureState['items'][number]),
    id: 'hostile',
    intent_or_expect: HOSTILE_WHAT,
    // Attested, because that is the branch M-12 binds and the branch this file is about.
    counterparty: { value: HOSTILE_NAME, origin: 'attested' as const },
    // Level 2, not 0: v0.2 suppresses an ATTESTED name whose level does not carry one, so at 0
    // there would be no name on the surface and this file would be testing the suppression rather
    // than the isolation. The dangerous case is precisely a name the evidence DOES support —
    // that is the one a client must render verbatim and must still contain.
    verification_level: '2' as const,
  };
  return {
    items: [item],
    // The three §7 views, held apart as a node holds them. This item is one the viewer owes;
    // the hostile string reaches the same renderer either way, and putting it in a bucket rather
    // than leaving the client to guess is the whole of the fix these members exist for.
    owe: [item],
    waiting: [],
    closed: [],
    pending: [{ ...item, id: 'hostile-pending', state: 'proposed', actions: [] }],
    brief: {
      generated_at: NOW,
      slots: [
        {
          headline: HOSTILE_WHAT,
          item_id: 'hostile',
          primary_action: { act: 'done', tool: 'act', args: { id: 'hostile', act: 'done' } },
        },
      ],
      below_the_line_count: 0,
    },
  };
}

async function hostileApp(surface: 'brief' | 'owe' | 'inbox'): Promise<AppView> {
  const state = hostileState();
  const client = new FixtureNodeClient(state);
  return loadApp(client, { surface, now: NOW, pending: { items: state.pending } });
}

/** C0, DEL and C1 — everything a terminal reads as an instruction rather than as a letter. */
const CONTROL = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'u');
/** Bidi overrides and isolates: a line that reads as one thing and contains another. */
const BIDI = new RegExp('[\\u202A-\\u202E\\u2066-\\u2069]', 'u');

describe('a promise cannot repaint the terminal it is shown in', () => {
  it('emits no line carrying a control character it did not write itself', async () => {
    for (const surface of ['brief', 'owe', 'inbox'] as const) {
      for (const line of frameLines({ app: await hostileApp(surface), cursor: 0 })) {
        expect(CONTROL.test(line), `${surface}: ${JSON.stringify(line)}`).toBe(false);
      }
    }
  });

  it('emits no bidi override, so a line reads as what it contains', async () => {
    for (const surface of ['brief', 'owe', 'inbox'] as const) {
      for (const line of frameLines({ app: await hostileApp(surface), cursor: 0 })) {
        expect(BIDI.test(line), `${surface}: ${JSON.stringify(line)}`).toBe(false);
      }
    }
  });

  it('keeps the name and its evidence on one line, which is where M-12 needs them', async () => {
    const view = await hostileApp('owe');
    const card = view.ledger.sections.find((s) => s.id === 'owe')?.cards[0];
    const trust = card?.withWhom?.trust.label ?? '';
    expect(trust.length).toBeGreaterThan(0);
    // Split on real newlines rather than on the array: a name carrying one of its own ends
    // the line the level was going to be on, and the array cannot see that.
    const printed = frame({ app: view, cursor: 0 }).split('\n');
    const naming = printed.filter((l) => l.includes('Dana Reyes'));
    expect(naming.length).toBeGreaterThan(0);
    for (const line of naming) expect(line).toContain(trust);
  });

  it('is scrubbed by the renderer, not by the fixture', async () => {
    // If the view model arrived clean this whole file would be asserting nothing. It does not:
    // the escapes travel all the way to the renderer, and the renderer is what stops them.
    const view = await hostileApp('owe');
    const card = view.ledger.sections.find((s) => s.id === 'owe')?.cards[0];
    expect(CONTROL.test(card?.what ?? '')).toBe(true);
    expect(CONTROL.test(card?.withWhom?.display ?? '')).toBe(true);
  });
});
