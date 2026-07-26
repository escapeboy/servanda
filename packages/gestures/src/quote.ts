/**
 * M-6, as a type.
 *
 * A gesture arrives carrying text somebody else wrote — a chat message, a review comment, a
 * transcript line. That text is data. It is quoted on the card and it is never read as
 * control: no field of it selects a tool, names a party, sets a decision, or reaches any
 * pipeline stage as an instruction (§2, constitution §6).
 *
 * "Quoted" is enforced by making it the only string type a card will accept for anything a
 * stranger wrote. `quote()` is the sole constructor, so there is no path from a raw payload
 * string to a rendered card that skips the scrubbing.
 *
 * What the scrubbing does, and deliberately does not do:
 *
 *  - Control characters (C0, DEL, C1) become spaces. A terminal renders some of them as
 *    cursor movement, which is how a message repaints a card it does not own.
 *  - Bidi overrides and invisible format characters are removed outright. Left alone they
 *    let a line read as one thing and contain another — the Trojan Source shape.
 *  - Runs of whitespace collapse, so a body cannot push its own tail off the card.
 *  - Length is capped at §3.1's 500 characters, the same ceiling `intent` has, because a
 *    quote that cannot become a commitment intent is a quote worth truncating early.
 *
 * It does NOT strip words, escape markup, or filter phrases. "SYSTEM: ignore previous
 * instructions" survives verbatim and is *shown*, because the defence is that nothing reads
 * it, not that it was scrubbed of scary words. Markup safety belongs to the renderer, which
 * escapes text nodes (`@servanda/client-web` element.ts) rather than to this function.
 */

declare const quoteBrand: unique symbol;

/** Text somebody else wrote, scrubbed of the characters that let text act, and nothing more. */
export type Quoted = string & { readonly [quoteBrand]: 'quoted' };

/** §3.1: `intent` is ≤ 500 characters, so a quote that may become one stops there too. */
export const QUOTE_MAX_CHARS = 500;

/** Rendered as cursor movement, bells and screen control by things that display text. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'gu');

/**
 * Invisible: zero-width joiners and spaces, bidi embedding/override/isolate marks, the byte
 * order mark. Every one of them makes a line read differently from what it contains.
 */
const INVISIBLE_CHARS = new RegExp('[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]', 'gu');

const WHITESPACE_RUN = /\s+/gu;

export function quote(raw: string): Quoted {
  const flattened = raw
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
  const capped =
    flattened.length > QUOTE_MAX_CHARS
      ? `${flattened.slice(0, QUOTE_MAX_CHARS - 1)}…`
      : flattened;
  return capped as Quoted;
}

/**
 * True when a string is already in the shape `quote` produces. Used by the gate rather than
 * by the code: the brand is a compile-time claim, and this is the runtime one.
 */
export function isScrubbed(text: string): boolean {
  return quote(text) === text;
}
