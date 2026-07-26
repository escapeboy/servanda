#!/usr/bin/env node
/**
 * Runs inside the trapped child spawned by prove-no-network.mjs. Everything §1 asks of the
 * identity layer, executed against the SHIPPED build, with every network primitive replaced by
 * a thrower. Prints one `REPORT {json}` line.
 *
 * Imports the built `dist/`, not `src/`, so what is proved offline is what would ship.
 */
import { derivePersona, mnemonicToSeed, withSignature } from '@servanda/crypto';
import {
  DomainAnchorResolver,
  IdentityVerifier,
  bindingLevel,
  recoveryPaths,
  resolveSuccessor,
  signBindingProof,
  signPersonaLink,
  signRotation,
  USER_INITIATED,
  verifyAttestation,
  verifyBindingProof,
  verifyPersonaLink,
  verifyRotation,
} from '../../dist/index.js';

const DENIED = 'NETWORK_ACCESS_DENIED';
const V = 'servanda/0.1';
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';

const seed = mnemonicToSeed(MNEMONIC);
const k = (i) => {
  const p = derivePersona(seed, i);
  return { id: p.personaId, privateKey: p.privateKey };
};
const ORG = k(10);
const MARIA = k(12);
const DANA = k(13);
const ATTACKER = k(14);
const FRESH = k(16);

const NOW = new Date('2026-03-01T00:00:00Z');
const clock = { now: () => NOW };
const CHANNEL = 'https://github.com/maria/servanda/blob/main/proof.json';

let deniedByIdentity = 0;
process.on('uncaughtException', (err) => {
  if (String(err?.message).includes(DENIED)) deniedByIdentity++;
  console.error(err.message);
  process.exit(1);
});

const att = withSignature(
  {
    v: V,
    type: 'attestation',
    org: ORG.id,
    subject: MARIA.id,
    subject_kind: 'persona',
    claims: { display_name: 'Maria Ivanova', handle: 'maria@acme.com' },
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: '2027-01-01T00:00:00Z',
  },
  ORG.privateKey,
);
const rev = withSignature(
  { v: V, type: 'revocation', org: ORG.id, subject: MARIA.id, revoked_at: '2026-06-01T00:00:00Z' },
  ORG.privateKey,
);

/** An entirely in-memory anchor transport: no socket, no resolver, no host lookup. */
const transport = {
  fetchWellKnown: async (url) => ({
    status: url === 'https://acme.com/.well-known/servanda.json' ? 200 : 404,
    body: JSON.stringify({ v: V, org_root: ORG.id, hubs: [] }),
    ttlSeconds: 600,
  }),
  resolveTxt: async () => [{ value: `v=servanda0.1; k=${ORG.id}`, ttlSeconds: 300 }],
};

const resolver = new DomainAnchorResolver({ transport, clock });
const anchor = await resolver.resolve('acme.com');

const attestVerdict = verifyAttestation(att, { now: NOW, subject: MARIA.id });
const graded = bindingLevel({
  subject: MARIA.id,
  priorConfirmedEdges: 2,
  attestation: attestVerdict,
  anchor,
});

const revokedAfter = verifyAttestation(att, {
  now: new Date('2026-09-01T00:00:00Z'),
  signedAt: new Date('2026-09-01T00:00:00Z'),
  revocations: [rev],
});
const revokedBefore = verifyAttestation(att, {
  now: new Date('2026-09-01T00:00:00Z'),
  signedAt: new Date('2026-03-01T00:00:00Z'),
  revocations: [rev],
});

const rotation = signRotation({
  oldPrivateKey: MARIA.privateKey,
  newPublicKey: FRESH.id,
  rotatedAt: '2026-05-01T00:00:00Z',
});
const forgedRotation = withSignature(
  { v: V, type: 'rotation', old: MARIA.id, new: ATTACKER.id, rotated_at: '2026-05-01T00:00:00Z' },
  ATTACKER.privateKey,
);

const link = signPersonaLink({
  privateKeyA: MARIA.privateKey,
  privateKeyB: DANA.privateKey,
  intent: USER_INITIATED,
});

const proofObj = signBindingProof({
  persona: MARIA.id,
  channelUrl: CHANNEL,
  privateKey: MARIA.privateKey,
});
const proofVerdict = verifyBindingProof(proofObj, {
  observed: { channelUrl: CHANNEL },
  persona: MARIA.id,
});

const verifier = new IdentityVerifier({ clock, resolver });
const endToEnd = await verifier.verify({
  subject: MARIA.id,
  attestations: [att],
  orgDomain: 'acme.com',
  priorConfirmedEdges: 1,
});

const recovered = recoveryPaths({
  lostPersona: MARIA.id,
  freshPersona: FRESH.id,
  rotation,
  bindingProof: proofVerdict,
  rotationPublishedAt: CHANNEL,
});
const unrecoverable = recoveryPaths({ lostPersona: MARIA.id, freshPersona: FRESH.id });

// ── control: the trap WOULD have caught a transport that reached out ───────────────────────
let trapWouldHaveCaught = false;
try {
  await globalThis.fetch('https://acme.com/.well-known/servanda.json');
} catch (err) {
  trapWouldHaveCaught = String(err?.message).includes(DENIED);
}
// …and a resolver wired to that transport degrades to `unreachable` rather than crashing.
const trappedResolution = await new DomainAnchorResolver({
  transport: { fetchWellKnown: (url) => globalThis.fetch(url) },
  clock,
}).resolve('acme.com');

const checks = {
  'anchor resolves from the injected transport': anchor.ok === true && anchor.anchor.org_root === ORG.id,
  'anchor cache is served without re-resolving': (await resolver.resolve('acme.com')).ok === true,
  'attestation verifies': attestVerdict.ok === true,
  'ladder reaches level 3 (which requires the anchor)': graded.level === '3',
  'level 3 carries the org-claimed name': graded.displayName === 'Maria Ivanova',
  'edge signed after revoked_at is not org-attested': revokedAfter.ok === false && revokedAfter.reason === 'revoked',
  'edge signed before revoked_at remains valid': revokedBefore.ok === true,
  'genuine rotation verifies and transfers continuity':
    verifyRotation(rotation).ok === true && resolveSuccessor(MARIA.id, [rotation]).current === FRESH.id,
  'forged rotation transfers nothing':
    verifyRotation(forgedRotation).ok === false &&
    resolveSuccessor(MARIA.id, [forgedRotation]).current === MARIA.id,
  'persona link verifies; one-sided link does not':
    verifyPersonaLink(link).ok === true &&
    verifyPersonaLink({ ...link, sig_B: link.sig_A }).ok === false,
  'binding proof verifies on its own channel only':
    proofVerdict.ok === true &&
    verifyBindingProof(proofObj, { observed: { channelUrl: 'https://evil.example/x' } }).ok === false,
  'IdentityVerifier grades end to end offline': endToEnd.level === '3',
  'ADR-0014 (b) recovery path found': recovered.recoverable === true,
  'no seed, no org, no proof is unrecoverable by design':
    unrecoverable.recoverable === false && unrecoverable.reason === 'unrecoverable-by-design',
  'a reaching transport degrades to unreachable, it does not crash':
    trappedResolution.ok === false && trappedResolution.reason === 'unreachable',
};

console.log(`REPORT ${JSON.stringify({ checks, trapWouldHaveCaught, deniedByIdentity })}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
