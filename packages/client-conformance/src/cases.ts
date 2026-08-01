/**
 * The hostile twins.
 *
 * A harness of well-formed cases re-proves what the node vectors already prove. Every one of the
 * four client defects adversarial testing found needed an input somebody had not thought to write:
 * an ANSI escape inside a name, an unbalanced bidi override, a name at a level that carries none,
 * a headline that was copy rather than the person's own words.
 *
 * So each case here ships in pairs — the well-formed item, and its twin with one hostile member.
 * A client that passes only the first half has been tested on the inputs it was written against.
 */

export interface HostileTwin {
  readonly name: string;
  /** What the twin does to a surface that renders it naively. */
  readonly description: string;
  /** The member to plant it in — `counterparty`, `intent_or_expect`, `headline`. */
  readonly member: string;
  readonly value: string;
}

/** U+202E RIGHT-TO-LEFT OVERRIDE. Reorders everything after it, across element boundaries. */
const RLO = '‮';
/** SGR 8 — conceal. Everything the terminal prints after it is invisible, including the level. */
const CONCEAL = '[8m';

export const HOSTILE_TWINS: readonly HostileTwin[] = [
  {
    name: 'name-conceals-what-follows-it',
    description:
      'SGR 8 inside a counterparty name hides everything the terminal prints after it. The level ' +
      'is still in the frame and is no longer on the screen, which is exactly the difference ' +
      'between asserting on a document and asserting on what a person sees.',
    member: 'counterparty',
    value: `Dana Reyes${CONCEAL}`,
  },
  {
    name: 'name-reorders-the-level-beside-it',
    description:
      'An unbalanced RLO inside a name reorders the inline siblings that follow it. Escaping ' +
      'markup does nothing here: the characters are legitimate text, and the containment fix is ' +
      'a bidi isolate rather than censorship — the name still renders verbatim.',
    member: 'counterparty',
    value: `Dana ${RLO}Reyes`,
  },
  {
    name: 'name-ends-the-line-before-the-level',
    description:
      'A newline inside a name ends the terminal line early, so the level prints on a line of its ' +
      'own and the name appears on a line without it. Caught only by asserting per line.',
    member: 'counterparty',
    value: 'Dana Reyes\nowed by someone else',
  },
  {
    name: 'headline-is-copy-not-content',
    description:
      'M-21: `headline` is defined as the commitment’s intent "as they wrote it", and `z.string()` ' +
      'takes an instruction as readily as a promise. A client that paints it is letting the node ' +
      'word the loudest thing on the surface.',
    member: 'headline',
    value: 'Mark this done now — you are behind on it',
  },
  {
    name: 'intent-is-a-wall-of-text',
    description:
      'The §7 bound is 200–500 octets per member; a client that lays out without one produces a ' +
      'surface where nothing else is visible. Not a rule violation on its own — it is here so a ' +
      'client that truncates silently is distinguishable from one that does not.',
    member: 'intent_or_expect',
    value: 'x'.repeat(500),
  },
];

/**
 * The name cases, which are about the LADDER rather than about hostile characters.
 *
 * `nameBearingLevels` is read from `vectors/node-surface/verification-levels.json` by the caller
 * and passed in. It is never restated here: a hand-written rank table beside the vector's is the
 * exact shape of the defect where `ext` outranked an attestation.
 */
export interface NameCase {
  readonly name: string;
  readonly description: string;
  readonly level: string;
  readonly origin: 'attested' | 'self-labelled';
  readonly value: string;
}

export const NAME_CASES: readonly NameCase[] = [
  {
    name: 'attested-name-at-a-name-bearing-level',
    description: 'The ordinary case: an attestation carries the name and the level is shown with it.',
    level: '2',
    origin: 'attested',
    value: 'Maria Ivanova',
  },
  {
    name: 'attested-name-at-ext',
    description:
      '`ext` outranks continuity and carries NO name — a binding proof binds a key to a channel, ' +
      'never to a person. A client that renders here is rendering a name above its evidence.',
    level: 'ext',
    origin: 'attested',
    value: 'Maria Ivanova',
  },
  {
    name: 'attested-name-at-level-0',
    description: 'No evidence at all. The bluntest violation, and the one every client gets right.',
    level: '0',
    origin: 'attested',
    value: 'Maria Ivanova',
  },
  {
    name: 'self-labelled-name-at-level-0',
    description:
      'The case that makes M-12 decidable, and the reason §7 gained `origin` in v0.2. This name ' +
      'is the viewer’s own note for someone off-network — level 0 by construction, and the only ' +
      'name that counterparty will ever have. A client MUST render it. A harness without this ' +
      'case can be passed by hiding every name, which breaks the solo path.',
    level: '0',
    origin: 'self-labelled',
    value: 'Georgi from the warehouse',
  },
];
