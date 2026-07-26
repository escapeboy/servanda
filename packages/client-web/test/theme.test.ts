import { describe, expect, it } from 'vitest';
import { BONE, BRONZE, INK, THEME_CSS, WAX_RESERVED_FOR_SEAL } from '../src/index.js';

/**
 * The palette is law, so it is parsed rather than eyeballed. Each check below is a line
 * from the doctrine that would otherwise decay the first time someone needed "just a bit
 * of the red somewhere else".
 */

interface Decl {
  readonly selector: string;
  readonly line: string;
}

/** Every line of the stylesheet, tagged with the selector it sits under. */
function declarations(css: string): Decl[] {
  const out: Decl[] = [];
  let selector = '';
  for (const raw of css.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.includes('{')) selector = line.slice(0, line.indexOf('{')).trim();
    out.push({ selector, line });
  }
  return out;
}

describe('wax is reserved exclusively for the seal', () => {
  it('spends the wax colour nowhere else in the stylesheet', () => {
    const spent = declarations(THEME_CSS).filter((d) =>
      d.line.toUpperCase().includes(WAX_RESERVED_FOR_SEAL.toUpperCase()),
    );
    expect(spent.length).toBeGreaterThan(0);
    for (const decl of spent) expect(decl.selector).toContain('seal');
  });

  it('does not offer wax as a token anyone could reuse', () => {
    expect(THEME_CSS).not.toContain('--wax');
  });
});

describe('the palette is exactly the five colours plus the two state tones', () => {
  it('uses no colour that was not decided', () => {
    const allowed = new Set(
      [INK, BONE, BRONZE, WAX_RESERVED_FOR_SEAL, '#4C6B4F', '#A8792B'].map((c) => c.toUpperCase()),
    );
    const used = new Set((THEME_CSS.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? []).map((c) => c.toUpperCase()));
    expect([...used].filter((c) => !allowed.has(c))).toEqual([]);
  });
});

describe('a register, not a dashboard', () => {
  it('defaults to light: bone under ink', () => {
    expect(THEME_CSS).toMatch(/\.servanda \{[^}]*background: var\(--bone\)/u);
    expect(THEME_CSS).toMatch(/\.servanda \{[^}]*color: var\(--ink\)/u);
  });

  it('makes dark mode the inversion onto ink and nothing more', () => {
    const dark = THEME_CSS.slice(THEME_CSS.indexOf('@media (prefers-color-scheme: dark)'));
    expect(dark).toContain('background: var(--ink)');
    expect(dark).toContain('color: var(--bone)');
  });

  it('has no gradients and no glows', () => {
    expect(THEME_CSS).not.toContain('gradient');
    for (const shadow of THEME_CSS.match(/box-shadow:[^;]+;/gu) ?? []) {
      // Third length in a box-shadow is the blur. A hairline is fine; a halo is not.
      const blur = shadow.match(/(-?[\d.]+)(?:px|rem)?\s+(-?[\d.]+)(?:px|rem)?\s+(-?[\d.]+)/u);
      expect(Number.parseFloat(blur?.[3] ?? '0')).toBe(0);
    }
  });
});

describe('the client renders offline', () => {
  it('fetches no font and no asset', () => {
    expect(THEME_CSS).not.toContain('@import');
    expect(THEME_CSS).not.toContain('url(');
    expect(THEME_CSS).not.toContain('http');
  });

  it('names the three faces and degrades to what the machine already has', () => {
    expect(THEME_CSS).toContain('Spectral');
    expect(THEME_CSS).toContain('Public Sans');
    expect(THEME_CSS).toContain('JetBrains Mono');
    expect(THEME_CSS).toMatch(/--display:[^;]*serif;/u);
    expect(THEME_CSS).toMatch(/--ui:[^;]*sans-serif;/u);
    expect(THEME_CSS).toMatch(/--mono:[^;]*monospace;/u);
  });
});

describe('the platform floor', () => {
  it('respects a request for reduced motion', () => {
    expect(THEME_CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('shows keyboard focus visibly', () => {
    expect(THEME_CSS).toContain(':focus-visible');
    expect(THEME_CSS).toMatch(/:focus-visible[^}]*outline:/u);
  });
});
