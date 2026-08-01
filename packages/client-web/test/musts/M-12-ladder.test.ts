import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VerificationLevel } from '@servanda/types';
import { RELIEF_BY_LEVEL, RELIEF_RANK, THEME_CSS } from '../../src/index.js';
import type { SealRelief } from '../../src/index.js';

/**
 * M-12, the half nothing was reading: the LADDER.
 *
 * §1.6 orders the levels `0 < 1 < ext < 2 < 3`. `ext` is a binding proof — the persona's own
 * signature on a channel it controls, which is self-assertion — so it outranks continuity and
 * is outranked by an attestation, where a third party stakes its own key.
 *
 * This client says the level in one way and one way only: degrees of relief struck into the
 * seal. So "MUST NOT render a display name above its evidence level" is, here, a statement
 * about relief — and the order of the reliefs has to be the order of the ladder, or the seal
 * says something the evidence does not.
 *
 * The order was never checked against anything. It was written down once in `RELIEF_RANK`,
 * with `external` at 3, tied with `domain` and above `attested`, and every test that used it
 * inherited that reading — including the one in M-12.test.ts that walks reliefs "higher than"
 * the rendered one, which at `ext` therefore walked an empty set and could not fail.
 *
 * The oracle is `vendor/vectors/node-surface/verification-levels.json`, which pins the total
 * order as data. Reading it rather than restating it is the point: a rank written twice is a
 * rank that can drift, and this one did.
 */

interface LevelVectors {
  readonly level_order: readonly VerificationLevel[];
  readonly level_rank: Readonly<Record<VerificationLevel, number>>;
}

const VECTORS = process.env['SERVANDA_VECTORS'] ?? join(process.cwd(), 'vendor/vectors');

function ladder(): LevelVectors {
  return JSON.parse(
    readFileSync(join(VECTORS, 'node-surface', 'verification-levels.json'), 'utf8'),
  ) as LevelVectors;
}

/**
 * How deeply the stylesheet strikes a given relief, in the one unit it actually varies:
 * border width. `.seal` sets 1px and each relief that goes deeper overrides it, so a relief
 * with no rule of its own is struck at the base.
 */
function struckWidth(relief: SealRelief): number {
  const block = new RegExp(String.raw`\.seal\.relief-${relief}\s*\{([^}]*)\}`, 'u').exec(THEME_CSS);
  const width = block === null ? null : /border-width:\s*(\d+)px/u.exec(block[1] ?? '');
  if (width !== null) return Number(width[1]);
  const base = /\.seal\s*\{[^}]*border:\s*(\d+)px/u.exec(THEME_CSS);
  return Number(base?.[1] ?? 1);
}

describe('M-12: the reliefs are ordered like the ladder they stand for', () => {
  it('ranks every relief exactly as §1.6 ranks the level behind it', () => {
    const { level_rank: rank } = ladder();
    const levels = Object.keys(rank) as VerificationLevel[];
    for (const a of levels) {
      for (const b of levels) {
        if (rank[a] >= rank[b]) continue;
        // A level below another on the ladder is struck below it in the seal. Strictly:
        // two levels that are distinct evidence must not be indistinguishable relief.
        expect(
          RELIEF_RANK[RELIEF_BY_LEVEL[a]],
          `${a} (rank ${rank[a]}) must rank below ${b} (rank ${rank[b]})`,
        ).toBeLessThan(RELIEF_RANK[RELIEF_BY_LEVEL[b]]);
      }
    }
  });

  it('strikes no seal deeper than the level above it on the ladder', () => {
    // The stylesheet is where the rule is finally kept or broken: a rank table can be right
    // while the wax says otherwise, and a person reads the wax.
    const { level_order: order } = ladder();
    let previous = 0;
    for (const level of order) {
      const width = struckWidth(RELIEF_BY_LEVEL[level]);
      expect(width, `relief for level ${level} is struck deeper than the level below it`)
        .toBeGreaterThanOrEqual(previous);
      previous = width;
    }
  });

  it('strikes ext shallower than an attestation, which is the case the order decides', () => {
    // Named on its own because it is the one comparison the old table got backwards, and a
    // loop that happened to stop being run would take the whole rule with it.
    expect(struckWidth(RELIEF_BY_LEVEL['ext'])).toBeLessThan(struckWidth(RELIEF_BY_LEVEL['2']));
  });
});
