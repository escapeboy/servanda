/**
 * `@servanda/identity` — spec §1, the verification half.
 *
 * Everything here is a *decision procedure*: given evidence, may this verifier stand behind
 * this claim? It performs no I/O of any kind. The two things §1 needs from the outside world —
 * an HTTPS GET of `/.well-known/servanda.json` and a DNS TXT lookup — are injected
 * (`AnchorTransport`), and time is injected (`Clock`). With neither injected the package still
 * answers every question; it just answers "no anchor" instead of reaching for one.
 *
 * That is not only testability. A verification library that can open a socket is a verification
 * library that can be made to leak who you are verifying.
 */
export * from './attestation.js';
export * from './anchor.js';
export * from './binding-proof.js';
export * from './ladder.js';
export * from './link.js';
export * from './rotation.js';
export * from './recovery.js';
export * from './verifier.js';
