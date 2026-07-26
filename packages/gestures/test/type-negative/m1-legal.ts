import { MILA, asOwn, confirmCard, utteranceFixture } from '../../src/index.js';

/**
 * The positive half of the M-1 compile-time control (gate GL, step 3).
 *
 * This file must typecheck. It is what makes the failure of its sibling meaningful: if
 * `confirmCard` refused everything, the negative control would prove nothing about ownership.
 */
const mine = asOwn(utteranceFixture(), MILA);
export const card = mine === null ? null : confirmCard(mine, 'pending-1');
