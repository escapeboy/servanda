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
