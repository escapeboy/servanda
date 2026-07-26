import { describe, expect, it } from 'vitest';
import { VERIFICATION_LEVEL_LABELS } from '@servanda/types';
import {
  DomainAnchorResolver,
  IdentityVerifier,
  LEVEL_RANK,
  bindingLevel,
  shortKey,
  signBindingProof,
  verifyAttestation,
  verifyBindingProof,
} from '../src/index.js';
import {
  MARIA,
  ORG,
  OTHER_ORG,
  T,
  anchorDocument,
  at,
  attestation,
  fixedClock,
  revocation,
  unreachableTransport,
  wellKnownTransport,
} from './support/fixture.js';

const NOW = at(T.before);
const CHANNEL = 'https://github.com/maria/servanda/blob/main/proof.json';

const goodAttestation = () =>
  verifyAttestation(attestation({ display_name: 'Maria Ivanova', handle: 'maria@acme.com' }), {
    now: NOW,
    subject: MARIA.id,
  });

const expiredAttestation = () => verifyAttestation(attestation(), { now: at(T.afterExpiry) });

const revokedAttestation = () =>
  verifyAttestation(attestation(), {
    now: at(T.after),
    signedAt: at(T.after),
    revocations: [revocation()],
  });

const goodProof = () =>
  verifyBindingProof(
    signBindingProof({ persona: MARIA.id, channelUrl: CHANNEL, privateKey: MARIA.privateKey }),
    { observed: { channelUrl: CHANNEL }, persona: MARIA.id },
  );

async function anchorFor(orgRoot: string) {
  return new DomainAnchorResolver({
    transport: wellKnownTransport(anchorDocument(orgRoot)),
    clock: fixedClock(T.before),
  }).resolve('acme.com');
}

describe('§1.6 binding-proof ladder', () => {
  it('level 0 with no evidence at all', () => {
    const id = bindingLevel({ subject: MARIA.id });
    expect(id.level).toBe('0');
    expect(id.levelLabel).toBe(VERIFICATION_LEVEL_LABELS['0']);
    expect(id.displayName).toBeNull();
  });

  it('level 1 from at least one prior confirmed edge with this key', () => {
    expect(bindingLevel({ subject: MARIA.id, priorConfirmedEdges: 0 }).level).toBe('0');
    expect(bindingLevel({ subject: MARIA.id, priorConfirmedEdges: 1 }).level).toBe('1');
    expect(bindingLevel({ subject: MARIA.id, priorConfirmedEdges: 12 }).level).toBe('1');
  });

  it('level 2 from a valid, unrevoked org attestation', () => {
    const id = bindingLevel({ subject: MARIA.id, attestation: goodAttestation() });
    expect(id.level).toBe('2');
    expect(id.displayName).toBe('Maria Ivanova');
    expect(id.handle).toBe('maria@acme.com');
    expect(id.attestedBy).toBe(ORG.id);
  });

  it('level 3 when the attesting org root is domain-anchored', async () => {
    const id = bindingLevel({
      subject: MARIA.id,
      attestation: goodAttestation(),
      anchor: await anchorFor(ORG.id),
    });
    expect(id.level).toBe('3');
    expect(id.anchoredDomain).toBe('acme.com');
    expect(id.displayName).toBe('Maria Ivanova');
  });

  it('level ext from a binding proof observed on its own channel', () => {
    const id = bindingLevel({ subject: MARIA.id, bindingProof: goodProof() });
    expect(id.level).toBe('ext');
    expect(id.externalChannel).toBe(CHANNEL);
    // ext binds a key to a channel. It carries no human name, so none is offered.
    expect(id.displayName).toBeNull();
  });

  it('reports every level achieved, and takes the highest', async () => {
    const id = bindingLevel({
      subject: MARIA.id,
      priorConfirmedEdges: 3,
      attestation: goodAttestation(),
      anchor: await anchorFor(ORG.id),
      bindingProof: goodProof(),
    });
    expect([...id.achieved].sort()).toEqual(['0', '1', '2', '3', 'ext']);
    expect(id.level).toBe('3');
  });

  it('ranks ext above continuity and below attested (documented, non-normative)', () => {
    expect(LEVEL_RANK['1']).toBeLessThan(LEVEL_RANK.ext);
    expect(LEVEL_RANK.ext).toBeLessThan(LEVEL_RANK['2']);
    const id = bindingLevel({ subject: MARIA.id, priorConfirmedEdges: 5, bindingProof: goodProof() });
    expect(id.level).toBe('ext');
  });

  describe('downgrades', () => {
    it('an expired attestation falls back to the level the rest of the evidence earns', () => {
      const id = bindingLevel({
        subject: MARIA.id,
        priorConfirmedEdges: 1,
        attestation: expiredAttestation(),
      });
      expect(id.level).toBe('1');
      expect(id.displayName).toBeNull();
      expect(id.downgrades.map((d) => d.reason)).toContain('expired');
    });

    it('a revoked-then-signed edge is not org-attested', () => {
      const id = bindingLevel({ subject: MARIA.id, attestation: revokedAttestation() });
      expect(id.level).toBe('0');
      expect(id.downgrades.map((d) => d.reason)).toContain('revoked');
    });

    it('an anchor that fails to resolve keeps the identity at level 2', async () => {
      const anchor = await new DomainAnchorResolver({
        transport: unreachableTransport(),
        clock: fixedClock(T.before),
      }).resolve('acme.com');
      const id = bindingLevel({ subject: MARIA.id, attestation: goodAttestation(), anchor });
      expect(id.level).toBe('2');
      expect(id.anchoredDomain).toBeNull();
      expect(id.downgrades.map((d) => d.reason)).toContain('anchor:unreachable');
    });

    it('an anchor whose org_root disagrees with the attestation never reaches level 3', async () => {
      const id = bindingLevel({
        subject: MARIA.id,
        attestation: goodAttestation(),
        anchor: await anchorFor(OTHER_ORG.id),
      });
      expect(id.level).toBe('2');
      expect(id.downgrades.map((d) => d.reason)).toContain('anchor:org-root-mismatch');
    });

    it('an anchor without a valid attestation confers nothing — 3 requires 2', async () => {
      const id = bindingLevel({
        subject: MARIA.id,
        attestation: expiredAttestation(),
        anchor: await anchorFor(ORG.id),
      });
      expect(id.level).toBe('0');
      expect(id.downgrades.map((d) => d.reason)).toContain('anchor:no-attestation-to-anchor');
    });

    it('a binding proof not observed on its own channel confers nothing', () => {
      const proof = verifyBindingProof(
        signBindingProof({ persona: MARIA.id, channelUrl: CHANNEL, privateKey: MARIA.privateKey }),
        { observed: { channelUrl: 'https://evil.example/mirror.json' }, persona: MARIA.id },
      );
      const id = bindingLevel({ subject: MARIA.id, bindingProof: proof });
      expect(id.level).toBe('0');
      expect(id.downgrades.map((d) => d.reason)).toContain('not-observed-on-its-channel');
    });
  });

  it('shortKey never dresses a key up as a name', () => {
    expect(shortKey(MARIA.id)).toContain('…');
    expect(shortKey(MARIA.id).length).toBeLessThan(MARIA.id.length);
    expect(bindingLevel({ subject: MARIA.id }).render).toEqual({
      name: shortKey(MARIA.id),
      isKey: true,
      level: '0',
      levelLabel: 'unconfirmed',
    });
  });
});

describe('IdentityVerifier — the one call a client makes', () => {
  it('resolves the anchor at verification time and grades in one pass', async () => {
    const verifier = new IdentityVerifier({
      clock: fixedClock(T.before),
      resolver: new DomainAnchorResolver({
        transport: wellKnownTransport(anchorDocument(ORG.id)),
        clock: fixedClock(T.before),
      }),
    });
    const id = await verifier.verify({
      subject: MARIA.id,
      attestations: [attestation({ display_name: 'Maria Ivanova' })],
      orgDomain: 'acme.com',
    });
    expect(id.level).toBe('3');
    expect(id.displayName).toBe('Maria Ivanova');
  });

  it('picks the attestation that verifies out of a set that includes forgeries', async () => {
    const verifier = new IdentityVerifier({ clock: fixedClock(T.before) });
    const id = await verifier.verify({
      subject: MARIA.id,
      attestations: [
        attestation({ signWith: OTHER_ORG, display_name: 'Impostor' }),
        attestation({ display_name: 'Maria Ivanova' }),
      ],
    });
    expect(id.level).toBe('2');
    expect(id.displayName).toBe('Maria Ivanova');
  });

  it('honours the offboarding boundary end to end', async () => {
    const verifier = new IdentityVerifier({ clock: fixedClock(T.after) });
    const args = {
      subject: MARIA.id,
      attestations: [attestation({ display_name: 'Maria Ivanova' })],
      revocations: [revocation()],
    };
    const before = await verifier.verify({ ...args, signedAt: at(T.before) });
    const after = await verifier.verify({ ...args, signedAt: at(T.after) });
    expect(before.level).toBe('2');
    expect(before.displayName).toBe('Maria Ivanova');
    expect(after.level).toBe('0');
    expect(after.displayName).toBeNull();
  });
});
