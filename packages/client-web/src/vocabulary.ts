/**
 * The vocabulary law, as code.
 *
 * "Human vocabulary everywhere: owe / waiting / closed. Edge, persona, supersession die at
 * the API boundary." A rule like that survives exactly as long as someone remembers it, so
 * it is written here once and checked by gate GE against the *rendered output* of all three
 * surfaces — not against the source, where the same words are legitimate type names.
 *
 * "Ledger" is on the list too. It is the right word for what this is and the wrong word to
 * show a person who has never used one.
 */

export const FORBIDDEN_TERMS = [
  'node',
  'vault',
  'mcp',
  'edge',
  'persona',
  'supersession',
  'ledger',
] as const;

export interface Violation {
  readonly term: string;
  readonly text: string;
}

const MATCHERS = FORBIDDEN_TERMS.map(
  (term) => [term, new RegExp(`\\b${term}s?\\b`, 'iu')] as const,
);

/** Word-boundary matching: "acknowledge" is a word, "edge" inside it is not a violation. */
export function scanVocabulary(strings: readonly string[]): Violation[] {
  const out: Violation[] = [];
  for (const text of strings) {
    for (const [term, matcher] of MATCHERS) {
      if (matcher.test(text)) out.push({ term, text });
    }
  }
  return out;
}

/**
 * Notary, not coach. One exclamation mark is the whole register slipping, so the count is
 * zero rather than low.
 */
export function scanExclamations(strings: readonly string[]): Violation[] {
  return strings
    .filter((text) => text.includes('!'))
    .map((text) => ({ term: 'exclamation mark', text }));
}

export function scanAll(strings: readonly string[]): Violation[] {
  return [...scanVocabulary(strings), ...scanExclamations(strings)];
}
