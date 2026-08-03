import { describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION } from '@servanda/types';
import {
  DomainAnchorResolver,
  recoveryPaths,
  signBindingProof,
  signRotation,
  verifyAttestation,
  verifyBindingProof,
} from '../src/index.js';
import {
  ATTACKER,
  FRESH,
  MARIA,
  ORG,
  T,
  anchorDocument,
  at,
  attestation,
  fixedClock,
  wellKnownTransport,
} from './support/fixture.js';

const CHANNEL = 'https://github.com/maria/servanda/blob/main/proof.json';
const NOW = at(T.before);

const reattestation = () =>
  verifyAttestation(attestation({ subject: FRESH.id, display_name: 'Maria Ivanova' }), {
    now: NOW,
    subject: FRESH.id,
  });

const channelProof = (persona = MARIA) =>
  verifyBindingProof(
    signBindingProof({ persona: persona.id, channelUrl: CHANNEL, privateKey: persona.privateKey }),
    { observed: { channelUrl: CHANNEL }, persona: persona.id },
  );

const rotationToFresh = () =>
  signRotation({
    oldPrivateKey: MARIA.privateKey,
    newPublicKey: FRESH.id,
    rotatedAt: '2026-02-01T00:00:00Z',
  });

describe('ADR-0014 seedless recovery', () => {
  it('(a) org re-attestation of a fresh persona recovers at level 2', () => {
    const result = recoveryPaths({
      lostPersona: MARIA.id,
      freshPersona: FRESH.id,
      reattestation: reattestation(),
    });
    expect(result.recoverable).toBe(true);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.kind).toBe('org-reattestation');
    expect(result.paths[0]?.level).toBe('2');
  });

  it('(a) reaches level 3 when the org root is domain-anchored', async () => {
    const anchor = await new DomainAnchorResolver({
      transport: wellKnownTransport(anchorDocument(ORG.id)),
      clock: fixedClock(T.before),
    }).resolve('acme.com');
    const result = recoveryPaths({
      lostPersona: MARIA.id,
      freshPersona: FRESH.id,
      reattestation: reattestation(),
      anchor,
    });
    expect(result.paths[0]?.level).toBe('3');
  });

  it('(a) refuses a re-attestation of somebody else’s key', () => {
    const result = recoveryPaths({
      lostPersona: MARIA.id,
      freshPersona: FRESH.id,
      reattestation: verifyAttestation(attestation({ subject: ATTACKER.id }), { now: NOW }),
    });
    expect(result.recoverable).toBe(false);
    expect(result.rejected[0]?.reason).toBe('attests a different subject');
  });

  it('(b) a rotation published on the lost persona’s binding-proof channel recovers', () => {
    const result = recoveryPaths({
      lostPersona: MARIA.id,
      freshPersona: FRESH.id,
      rotation: rotationToFresh(),
      bindingProof: channelProof(),
      rotationPublishedAt: CHANNEL,
    });
    expect(result.recoverable).toBe(true);
    expect(result.paths[0]?.kind).toBe('external-proof-rotation');
    expect(result.paths[0]?.level).toBe('ext');
  });

  it('(b) refuses when the rotation was published somewhere other than the channel', () => {
    const result = recoveryPaths({
      lostPersona: MARIA.id,
      freshPersona: FRESH.id,
      rotation: rotationToFresh(),
      bindingProof: channelProof(),
      rotationPublishedAt: 'https://evil.example/rotation.json',
    });
    expect(result.recoverable).toBe(false);
    expect(result.rejected[0]?.reason).toBe('rotation:not-published-on-the-binding-proof-channel');
  });

  it('(b) refuses when the binding proof belongs to a different persona', () => {
    const result = recoveryPaths({
      lostPersona: MARIA.id,
      freshPersona: FRESH.id,
      rotation: rotationToFresh(),
      bindingProof: channelProof(ATTACKER),
      rotationPublishedAt: CHANNEL,
    });
    expect(result.recoverable).toBe(false);
    expect(result.rejected[0]?.reason).toBe('binding-proof:wrong-persona');
  });

  it('(b) refuses a rotation the old key did not sign, however good the channel is', () => {
    const forged = withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'rotation' as const,
        old: MARIA.id,
        new: ATTACKER.id,
        rotated_at: '2026-02-01T00:00:00Z',
      },
      ATTACKER.privateKey,
    );
    const result = recoveryPaths({
      lostPersona: MARIA.id,
      freshPersona: ATTACKER.id,
      rotation: forged,
      bindingProof: channelProof(),
      rotationPublishedAt: CHANNEL,
    });
    expect(result.recoverable).toBe(false);
    expect(result.rejected[0]?.reason).toBe('rotation:not-signed-by-old-key');
  });

  it('the seed, when it exists, re-derives the persona itself', () => {
    const result = recoveryPaths({
      lostPersona: MARIA.id,
      freshPersona: MARIA.id,
      seedAvailable: true,
    });
    expect(result.recoverable).toBe(true);
    expect(result.paths[0]?.kind).toBe('seed');
  });

  it('does not say "unrecoverable by design" to somebody nobody asked about the seed', () => {
    // The heaviest sentence this module can produce, and the input that used to produce it is the
    // one every caller starts from: lost persona, fresh persona, nothing else known yet. Telling
    // that person their persona is gone forever — when the 24 words in their desk drawer would
    // have restored it outright — is the module answering a question it was never asked.
    const result = recoveryPaths({ lostPersona: MARIA.id, freshPersona: FRESH.id });
    expect(result.recoverable).toBe(false);
    expect(result.paths).toEqual([]);
    expect(result.reason).toBe('seed-not-established');
  });

  it('no seed, no org, no external proof is unrecoverable BY DESIGN — there is no fallback', () => {
    const result = recoveryPaths({
      lostPersona: MARIA.id,
      freshPersona: FRESH.id,
      // Asked, and answered: this is what earns the verdict below.
      seedAvailable: false,
    });
    expect(result.recoverable).toBe(false);
    expect(result.paths).toEqual([]);
    expect(result.reason).toBe('unrecoverable-by-design');
    // ADR-0014: "no anchor means no way to distinguish the owner from an impostor." The
    // assertion that matters is that the module offers nothing else — not that it errors.
    expect(result.rejected).toEqual([]);
  });
});
