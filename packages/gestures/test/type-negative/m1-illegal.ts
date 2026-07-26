import { confirmCard, recordCard, utteranceFixture } from '../../src/index.js';

/**
 * The negative half of the M-1 compile-time control (gate GL, step 3).
 *
 * This file MUST NOT typecheck. Every line below is an attempt to make a gesture record a
 * promise that is not the confirming person's own, and every one of them is rejected by the
 * type of `OwnUtterance` rather than by a check inside a function body — which is what
 * "unrepresentable rather than checked" means in practice.
 *
 * The gate runs `tsc --noEmit` on this file and fails if it *succeeds*.
 */
const theirs = utteranceFixture();

// A plain Utterance is not an OwnUtterance. There is no cast here and no null check: this is
// the shape somebody reaches for when they want to confirm on another person's behalf.
export const a = confirmCard(theirs, 'pending-1');
export const b = recordCard(theirs, 'anything');
