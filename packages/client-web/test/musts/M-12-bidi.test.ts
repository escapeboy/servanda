import { describe, expect, it } from 'vitest';
import { appEl, cardEl, cardFor, walk } from '../../src/index.js';
import { NOW, everyViewAnywhere } from '../fixture.js';

/**
 * M-12 in a browser, where the attack is not a control character but a direction.
 *
 * `escapeHtml` covers markup and covers it properly. It does not cover U+202E RIGHT-TO-LEFT
 * OVERRIDE, and nothing else does either: §7's `counterparty` is a plain string and travels
 * from a connector, an extraction or a counterparty's own proposal.
 *
 * A name and its level are inline siblings inside one `<p class="with">`, which makes them
 * ONE bidi paragraph. An unterminated override inside the name therefore reorders the
 * characters of the level beside it — "unconfirmed name" rendered right-to-left is not a
 * legible statement of evidence, and a name that keeps its shape beside an unreadable level
 * is a name rendered above its evidence.
 *
 * Stripping the character is the wrong answer: RTL scripts are not an attack and a name is
 * content. The right answer is the one HTML already has — put person-authored text in a
 * `bdi`, whose whole purpose is that its direction cannot escape it.
 *
 * HONEST LIMIT: this asserts the element, not the reordering. There is no browser in this
 * workspace, so what is checked is that every rendered name sits in the element the bidi
 * algorithm isolates — not that a given engine then isolates it.
 */

const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);

function itemWith(counterparty: string, origin: 'attested' | 'self-labelled' = 'attested') {
  return {
    kind: 'commitment' as const,
    id: 'i-bidi',
    intent_or_expect: 'Send the revised quote',
    counterparty: { value: counterparty, origin },
    // Level 2, not 0: v0.2 suppresses an ATTESTED name whose level does not carry one, so at 0
    // there would be no name on the surface and this file would be testing the suppression rather
    // than the isolation. The dangerous case is precisely a name the evidence DOES support —
    // that is the one a client must render verbatim and must still contain.
    verification_level: '2' as const,
    age_days: 3,
    due: null,
    state: 'open',
    actions: [],
  };
}

/** Every element that carries a display name, on every surface this client has. */
function nameNodes(tree: ReturnType<typeof appEl>) {
  return walk(tree).filter((n) => {
    const classes = String(n.attrs?.['class'] ?? '').split(' ');
    return classes.includes('party') && !classes.includes('party-self');
  });
}

describe('M-12: a name cannot reorder the evidence standing beside it', () => {
  it('isolates every rendered name, on every surface', async () => {
    let seen = 0;
    for (const view of await everyViewAnywhere()) {
      for (const node of nameNodes(appEl(view))) {
        seen++;
        expect(node.tag, 'a name shares a bidi paragraph with its level').toBe('bdi');
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('isolates a name that carries an override, rather than removing what it wrote', async () => {
    const hostile = `Dana Reyes${RIGHT_TO_LEFT_OVERRIDE}`;
    const card = cardFor(itemWith(hostile), NOW, false);
    const [name] = nameNodes(cardEl(card));
    expect(name?.tag).toBe('bdi');
    // The name is shown as it was recorded. The defence is containment, not censorship.
    expect(name?.text).toBe(hostile);
  });
});
