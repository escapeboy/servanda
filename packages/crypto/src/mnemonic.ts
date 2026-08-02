import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

/**
 * §1.1: a root identity is a 256-bit seed; implementations MUST support BIP-39
 * 24-word mnemonic encoding for the recovery kit.
 */

const ENTROPY_BITS_256 = 256;

export function generateRootMnemonic(): string {
  return generateMnemonic(wordlist, ENTROPY_BITS_256);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

/** BIP-39 mnemonic → 64-byte seed. */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Uint8Array {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new TypeError('invalid BIP-39 mnemonic (checksum or wordlist failure)');
  }
  return mnemonicToSeedSync(mnemonic, passphrase);
}

/**
 * Seed derivation without checksum enforcement — required for the published BIP-39 test
 * mnemonics used by the conformance vectors, which are valid, and for round-tripping a
 * seed a user restores from a non-BIP-39 kit (§1.1 allows other encodings).
 */
export function mnemonicToSeedUnchecked(mnemonic: string, passphrase = ''): Uint8Array {
  return mnemonicToSeedSync(mnemonic, passphrase);
}

/**
 * §9.3: where an implementation GENERATES a vault passphrase it MUST come from a CSPRNG with at
 * least 128 bits of entropy.
 *
 * The rule is on generation, not on acceptance, and the difference matters. §9.3 fixes what
 * Argon2id costs an attacker per guess; how many guesses they need is decided by the passphrase,
 * and at every parameter set in the range this specification discusses it is the entropy that
 * decides the outcome, not the KDF. A 1 GiB profile over a passphrase drawn from a person's
 * memory is a slow search of a small space. Refusing a passphrase the OWNER chose is a product
 * decision this takes no position on; producing a weak one ourselves is a defect.
 *
 * The BIP-39 wordlist rather than a character alphabet: 2048 words is 11 bits each, so twelve
 * words is 132 bits, and the words are already the recovery-kit vocabulary a user of this system
 * has seen. Transcribable, dictateable, and no ambiguity about `l` versus `1`.
 */
export const GENERATED_PASSPHRASE_WORDS = 12;
export const GENERATED_PASSPHRASE_BITS = GENERATED_PASSPHRASE_WORDS * 11;

export function generatePassphrase(words = GENERATED_PASSPHRASE_WORDS): string {
  if (words * 11 < 128) {
    throw new RangeError(`§9.3: ${words} words is ${words * 11} bits; the floor is 128`);
  }
  // `generateMnemonic` is the CSPRNG draw plus a checksum. Sliced to `words` because a passphrase
  // is not a mnemonic — nothing derives a key path from it and no checksum is meaningful, so the
  // extra words would only be entropy nobody counts.
  return generateMnemonic(wordlist, 256).split(' ').slice(0, words).join(' ');
}
