import { describe, expect, it } from 'vitest';
import type { VerificationLevel } from '@servanda/types';
import { VERIFICATION_LEVEL_LABELS } from '@servanda/types';
import {
  COPY,
  RELIEF_BY_LEVEL,
  RELIEF_RANK,
  appEl,
  cardEl,
  cardFor,
  partyFor,
  renderToHtml,
  trustFor,
  walk,
} from '../../src/index.js';
import { NOW, everySurface, everyViewAnywhere } from '../fixture.js';

const LEVELS = Object.keys(VERIFICATION_LEVEL_LABELS) as VerificationLevel[];

function itemAt(level: VerificationLevel, counterparty = 'Dana Reyes') {
  return {
    kind: 'commitment' as const,
    id: `i-${level}`,
    intent_or_expect: 'Send the revised quote',
    counterparty,
    verification_level: level,
    age_days: 3,
    due: null,
    state: 'open',
    actions: ['done' as const],
  };
}

/**
 * M-12 — "Clients MUST display verification level and MUST NOT render a display name above
 * its evidence level."
 *
 * Both halves are structural here rather than a discipline applied at each call site. The
 * name and its evidence are produced by one function from one input, so there is no
 * argument by which a caller could ask for a name dressed in more relief than it has
 * earned; and the interface has no code path that emits the one without the other.
 */
describe('M-12: the level is always displayed, and a name never rises above its evidence', () => {
  it('displays a level for every one of the five levels', () => {
    for (const level of LEVELS) {
      const trust = trustFor(level);
      expect(trust.level).toBe(level);
      expect(trust.label).toBe(COPY.trust[level]);
      expect(trust.label.length).toBeGreaterThan(0);
    }
  });

  it('renders relief that is exactly the evidence, never more', () => {
    for (const level of LEVELS) {
      const relief = RELIEF_BY_LEVEL[level];
      const html = renderToHtml(cardEl(cardFor(itemAt(level), NOW, false)));
      expect(html).toContain(`relief-${relief}`);
      // No higher relief leaks into the same card.
      for (const other of Object.values(RELIEF_BY_LEVEL)) {
        if (RELIEF_RANK[other] > RELIEF_RANK[relief]) {
          expect(html).not.toContain(`relief-${other}`);
        }
      }
    }
  });

  /**
   * The assertion above was true of a page on which relief was INVISIBLE.
   *
   * `toContain` cannot tell which element carries a class. Relief was emitted on the trust
   * text while the stylesheet strikes it on `.seal.relief-*`, so every level from continuity
   * upward rendered as the same 1px circle and this suite stayed green. Browsers match rules
   * by element, so the test has to as well.
   */
  it('strikes the relief on the seal, where the stylesheet can reach it', () => {
    for (const level of LEVELS) {
      const relief = RELIEF_BY_LEVEL[level];
      const html = renderToHtml(cardEl(cardFor(itemAt(level), NOW, false)));
      const sealClass = /class="(seal[^"]*)"/u.exec(html)?.[1] ?? '';
      expect(sealClass, `level ${level}`).toContain(`relief-${relief}`);
    }
  });

  it('shows an unconfirmed name as unconfirmed, in flat relief', () => {
    const html = renderToHtml(cardEl(cardFor(itemAt('0'), NOW, false)));
    expect(html).toContain('relief-flat');
    expect(html).toContain(COPY.trust['0']);
    expect(html).toContain('Dana Reyes');
  });

  it('emits no name without its evidence, on any surface', async () => {
    // Every surface, including the team standup and the proof page — a certificate a
    // stranger reads is exactly where a bare name would do the most damage.
    let names = 0;
    for (const view of await everyViewAnywhere()) {
      const tree = appEl(view);
      const nodes = walk(tree);
      for (const node of nodes) {
        const classes = String(node.attrs?.['class'] ?? '').split(' ');
        // "Just you" is not a name, so it has no evidence level to carry.
        if (!classes.includes('party') || classes.includes('party-self')) continue;
        names++;
        // Every rendered name sits in a paragraph that also carries its level.
        const paragraph = nodes.find((candidate) => (candidate.children ?? []).includes(node));
        const siblings = paragraph?.children ?? [];
        const trust = siblings.find((s) => String(s.attrs?.['class'] ?? '').startsWith('trust'));
        expect(trust).toBeDefined();
        expect(String(trust?.attrs?.['data-level'] ?? '').length).toBeGreaterThan(0);
      }
    }
    expect(names).toBeGreaterThan(0);
  });

  it('takes the level as its only input: there is no way to ask for more relief', () => {
    for (const level of LEVELS) {
      const party = partyFor('Dana Reyes', level);
      expect(party?.trust.relief).toBe(RELIEF_BY_LEVEL[level]);
      expect(RELIEF_RANK[party?.trust.relief ?? 'flat']).toBeLessThanOrEqual(
        RELIEF_RANK[RELIEF_BY_LEVEL[level]],
      );
    }
  });

  it('does not dress a raw key up as a name', () => {
    const party = partyFor('f'.repeat(64), '0');
    expect(party?.isKey).toBe(true);
    expect(party?.display).not.toBe('f'.repeat(64));
    expect(renderToHtml(cardEl(cardFor(itemAt('0', 'f'.repeat(64)), NOW, false)))).toContain(
      'party party-key',
    );
  });
});
