# @servanda/crypto

Cryptographic primitives for the Servanda protocol. Everything here is pinned by the conformance
vectors — this package is the one whose output other implementations must match byte for byte.

## Canonicalization (RFC 8785 JCS)

```ts
import { canonicalize, canonicalBytes, hashCanonical } from '@servanda/crypto';

canonicalize({ b: 1, a: 2 });   // '{"a":2,"b":1}'
hashCanonical(obj);              // sha256 over the canonical UTF-8 bytes
```

Serialization is written out by hand rather than by sorting keys into a new object and calling
`JSON.stringify`. JavaScript objects reorder integer-like keys ahead of string keys regardless of
insertion order, so `{"10":…, "2":…}` would silently come out in the wrong order — a
canonicalization bug that only shows up when two implementations disagree about a hash.

Numbers follow the ECMAScript `Number::toString` algorithm (which `JSON.stringify` implements) and
keys sort by UTF-16 code unit (which JS's default string sort is). Non-finite numbers throw rather
than emitting invalid JSON.

## Hashing the protocol's identities

```ts
commitmentHash({ intent, owner, owed_to, due, created_at });  // §3.2 — exactly five fields
edgeId({ commitment_hash, owner, owed_to, proposed_at });     // §4.1
```

`commitmentHash` covers **only** those five fields. Evidence, confidence, source and conditions are
vault-local and excluded, so two parties can agree on a promise without sharing evidence sets. The
14 hashing vectors exist to prove no sixth field reaches the hash.

`edgeId` concatenates the four values' UTF-8 bytes with no separator — the spec writes `||` without
defining it (upstream issue #10), so this follows the vectors, which are the oracle.

## Signing

```ts
signObject(obj, privateKeyHex);      // ed25519 over sha256(JCS(obj minus "sig"))
withSignature(obj, privateKeyHex);   // → { ...obj, sig }
verifyObject(signedObj, publicKeyHex);
```

`verifyObject` returns `false` rather than throwing on malformed input: a bad signature arriving
over the wire is an expected condition, not an exceptional one (§4.3 discards it).

## Identity derivation

```ts
const seed = mnemonicToSeed(mnemonic);        // BIP-39
const persona = derivePersona(seed, 0);       // SLIP-0010 m/7391'/0'
persona.personaId;                            // hex(pubkey) — §1.2
```

Hardened derivation only. An unhardened path segment throws: §1.2 requires one-wayness, so
unhardened derivation is a protocol violation, not a fallback.

## Vault content keys (M-16)

```ts
const ck = generateContentKey();
const keyset = sealContentKey(ck, [
  wrapForPassphrase(ck, passphrase),
  wrapForDevice(ck, deviceKey, 'laptop'),
]);
```

`sealContentKey` **refuses** to produce a keyset without a passphrase wrap. M-16 says a device key
must not be the sole custodian of vault content keys, so the illegal state is unrepresentable
rather than merely discouraged. Argon2id runs at the §9.3 minimum (m=64MiB, t=3, p=1), which costs
about 1.2 s per derivation — the correct price for a passphrase KDF, and the reason unlocking a
vault is a deliberate act rather than something done per request.

## Blind courier (§6.3)

```ts
const sealed = sealToPersona(recipientPersonaId, plaintext);
openSealed(recipientPrivateKey, sealed);
```

X25519 from the Ed25519 keys, XChaCha20-Poly1305, ephemeral sender key. A conforming hub sees the
recipient, the ciphertext and a timestamp — not the sender, and not the content. HPKE is the
targeted profile for v0.2 (upstream issue #6).
