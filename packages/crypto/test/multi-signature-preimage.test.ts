import { describe, expect, it } from 'vitest';
import { canonicalBytes } from '../src/jcs.js';
import { sha256, toHex } from '../src/hash.js';
import { signingPreimageHex, unsigned } from '../src/sign.js';

/**
 * §0: "The preimage of every signature is `sha256(JCS(O))`, where `O` is the object with every
 * member whose name is `sig` or begins with `sig_` removed. […] every signer therefore signs
 * identical bytes."
 *
 * Only `sig` was removed. On a single-signature object that is the same thing, which is why it
 * held for so long — but on the multi-signature objects the protocol actually has (§1.6
 * `sig_A`/`sig_B`, §1.7's withdrawn `sig_old`/`sig_new`) it is not: whichever signer went second
 * signed the first signature along with the object, so the two signers did not sign identical
 * bytes and the second signature could not be produced without the first. Every multi-signature
 * site in the codebase worked around it by hand-building its own core object, which is the shape
 * a rule takes when it lives in the callers instead of the function named after it.
 */

const CORE = { v: 'servanda/0.2', type: 'link', personas: ['a'.repeat(64), 'b'.repeat(64)] };

describe('§0 signing preimage: `sig` and every `sig_*` member is removed', () => {
  it('drops sig_A and sig_B, so both signers sign identical bytes', () => {
    const signedByA = { ...CORE, sig_A: 'c'.repeat(128) };
    const signedByBoth = { ...CORE, sig_A: 'c'.repeat(128), sig_B: 'd'.repeat(128) };
    const bare = toHex(sha256(canonicalBytes(CORE)));

    expect(signingPreimageHex(CORE)).toBe(bare);
    expect(signingPreimageHex(signedByA)).toBe(bare);
    expect(signingPreimageHex(signedByBoth)).toBe(bare);
  });

  it('drops `sig` and `sig_*` together on an object carrying both encodings', () => {
    const rotation = { v: 'servanda/0.2', type: 'rotation', old: 'a', new: 'b' };
    expect(signingPreimageHex({ ...rotation, sig: 'e'.repeat(128), sig_old: 'f'.repeat(128) })).toBe(
      signingPreimageHex(rotation),
    );
  });

  it('removes nothing else that merely starts with the same letters', () => {
    // `signal`, `signed_at`, `signature` — the rule names `sig` exactly, or a `sig_` prefix.
    const obj = { v: 'servanda/0.2', signal: 'x', signed_at: 'y', signature: 'z' };
    expect(unsigned(obj)).toEqual(obj);
  });

  it('is a top-level rule: an inner signature stays inside the outer preimage', () => {
    // The alternative reading — strip recursively — would mean an outer signature does not
    // cover the signatures nested in its payload, so a relay could swap an inner `sig` for
    // another valid one without breaking the outer one. §6.3 leans on the outer signature
    // catching exactly that.
    const withInner = (sig: string) => ({
      v: 'servanda/0.2',
      type: 'propose',
      payload: { assertion: { state: 'proposed', sig } },
    });
    expect(signingPreimageHex(withInner('1'.repeat(128)))).not.toBe(
      signingPreimageHex(withInner('2'.repeat(128))),
    );
  });
});

/**
 * The consequence nobody had written down, found by S3 reading the change rather than the tests.
 *
 * Implementing §0's rule falsified a claim `rotation.ts` was still making in a comment beside a
 * signature check: that `sig_old`/`sig_new` sit inside `sig`'s preimage and so cannot be stripped
 * or swapped without invalidating it. They can. That is what "every signer covers identical bytes"
 * means, and it is the point of the rule — but a stale comment beside a security check is how the
 * next reader reasons from a guarantee that no longer exists.
 */
describe('§0: what stripping `sig_*` actually gives away', () => {
  it('a `sig_*` member can be added or removed without disturbing `sig`', () => {
    const rotation = { v: 'servanda/0.2', type: 'rotation', old: 'a', new: 'b' };
    const signed = { ...rotation, sig: 'e'.repeat(128) };
    expect(signingPreimageHex(signed)).toBe(signingPreimageHex({ ...signed, sig_old: 'f'.repeat(128) }));
    expect(signingPreimageHex(signed)).toBe(signingPreimageHex({ ...signed, sig_new: '1'.repeat(128) }));
  });

  it('so a legacy `sig_old` verifies as `sig` with no key at all', () => {
    // `sig_old` was always a signature by the old key over these bytes; §0 now says so out loud.
    // An opt-in gate in front of it is a gate in front of an open door — worth knowing, and not a
    // forgery: nothing is accepted that the old key did not sign.
    const rotation = { v: 'servanda/0.2', type: 'rotation', old: 'a', new: 'b' };
    const legacy = { ...rotation, sig_old: 'c'.repeat(128) };
    const promoted = { ...rotation, sig: legacy.sig_old };
    expect(signingPreimageHex(promoted)).toBe(signingPreimageHex(legacy));
  });
});
