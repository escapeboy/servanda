/**
 * @servanda/client-conformance — the client half of the suite.
 *
 * §8: "A vector pins what a node emits. It cannot inspect what a client paints, so the client
 * halves of M-12 and M-21 are prose obligations, not suite-enforced ones, until a client-side
 * conformance harness exists." This is that harness.
 *
 * It judges a RENDERED FACT SET rather than a document, because everything that actually broke
 * these rules broke in the last inch — a class on an element, an escape byte inside a line, a
 * border-width in a stylesheet. It ships hostile twins rather than well-formed cases, because a
 * harness of well-formed cases re-proves what the node vectors already prove. And it states two
 * negative universals rather than per-case assertions, because "no string reaches the screen
 * unless somebody claimed it" is a set difference and cannot be satisfied by luck.
 *
 * Two limits, stated rather than papered over: it asserts the `bdi` element, not that a text engine
 * isolates it; and it asserts the declared style, not painted pixels.
 */
export type { RenderedFact, Surface } from './fact.js';
export { factsFromLines, factsFromTree } from './fact.js';
export type { Content, NameUnderTest, Verdict } from './judge.js';
export { judgeCopy, judgeName, judgeStyleOrdering } from './judge.js';
export type { HostileTwin, NameCase } from './cases.js';
export { HOSTILE_TWINS, NAME_CASES } from './cases.js';
