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
