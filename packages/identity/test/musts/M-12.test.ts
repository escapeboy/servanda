import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { VerificationLevel } from '@servanda/types';
import { VERIFICATION_LEVEL_LABELS } from '@servanda/types';
import type { VerifiedIdentity } from '../../src/index.js';
import {
  DomainAnchorResolver,
  LEVEL_RANK,
  bindingLevel,
  shortKey,
  signBindingProof,
  verifyAttestation,
  verifyBindingProof,
} from '../../src/index.js';
import {
  MARIA,
  ORG,
  T,
  anchorDocument,
  at,
  attestation,
  fixedClock,
  revocation,
  unreachableTransport,
  wellKnownTransport,
} from '../support/fixture.js';

/**
 * M-12 — "Clients MUST display verification level and MUST NOT render a display name above
 * its evidence level."
 *
 * This layer owns the *production* half: whatever a client renders, it renders from a
 * `VerifiedIdentity`, and a `VerifiedIdentity` cannot exist with a name its level has not
 * earned. `packages/client-web` owns the rendering half of the same rule.
 *
 * The property is structural, not a checklist applied per call site:
 *   - `bindingLevel` is the only producer of a `VerifiedIdentity`;
 *   - the constructor is private, so no caller can assemble one by hand;
 *   - the name and the level are decided in one expression from one input, so there is no
 *     argument by which a caller could request one without the other.
 */

const NAME = 'Maria Ivanova';
const CHANNEL = 'https://github.com/maria/servanda/blob/main/proof.json';
const LEVELS = Object.keys(VERIFICATION_LEVEL_LABELS) as VerificationLevel[];

const attested = (now = at(T.before)) =>
  verifyAttestation(attestation({ display_name: NAME, handle: 'maria@acme.com' }), {
    now,
    subject: MARIA.id,
  });

const proof = () =>
  verifyBindingProof(
    signBindingProof({ persona: MARIA.id, channelUrl: CHANNEL, privateKey: MARIA.privateKey }),
    { observed: { channelUrl: CHANNEL }, persona: MARIA.id },
  );

async function anchor(orgRoot: string, reachable = true) {
  return new DomainAnchorResolver({
    transport: reachable ? wellKnownTransport(anchorDocument(orgRoot)) : unreachableTransport(),
    clock: fixedClock(T.before),
  }).resolve('acme.com');
}

/** One graded identity per level, each built from real evidence rather than a literal. */
async function oneOfEachLevel(): Promise<Record<VerificationLevel, VerifiedIdentity>> {
  return {
    '0': bindingLevel({ subject: MARIA.id }),
    '1': bindingLevel({ subject: MARIA.id, priorConfirmedEdges: 1 }),
    ext: bindingLevel({ subject: MARIA.id, bindingProof: proof() }),
    '2': bindingLevel({ subject: MARIA.id, attestation: attested() }),
    '3': bindingLevel({
      subject: MARIA.id,
      attestation: attested(),
      anchor: await anchor(ORG.id),
    }),
  };
}

describe('M-12: the level is always available, and a name never rises above its evidence', () => {
  it('every graded identity carries a level and its label', async () => {
    const byLevel = await oneOfEachLevel();
    for (const level of LEVELS) {
      const id = byLevel[level];
      expect(id.level, level).toBe(level);
      expect(id.levelLabel).toBe(VERIFICATION_LEVEL_LABELS[level]);
      expect(id.render.level).toBe(level);
      expect(id.render.levelLabel.length).toBeGreaterThan(0);
    }
  });

  it('a human name appears only at the levels whose evidence carries one', async () => {
    const byLevel = await oneOfEachLevel();
    // §1.3: display_name is an org's claim. Only an org attestation carries it, so only the
    // levels an attestation establishes (2 and 3) may show it.
    expect(byLevel['2'].displayName).toBe(NAME);
    expect(byLevel['3'].displayName).toBe(NAME);
    for (const level of ['0', '1', 'ext'] as const) {
      expect(byLevel[level].displayName, level).toBeNull();
      expect(byLevel[level].handle, level).toBeNull();
      expect(byLevel[level].render.isKey, level).toBe(true);
      expect(byLevel[level].render.name).toBe(shortKey(MARIA.id));
      expect(byLevel[level].render.name).not.toContain(NAME);
    }
  });

  it('an org can claim any name it likes; the name only travels at the level it earned', () => {
    const grand = verifyAttestation(attestation({ display_name: 'Chief Executive, ACME' }), {
      now: at(T.before),
      subject: MARIA.id,
    });
    expect(bindingLevel({ subject: MARIA.id, attestation: grand }).displayName).toBe(
      'Chief Executive, ACME',
    );
    // Same claim, evidence removed: the name goes with it.
    const stale = verifyAttestation(attestation({ display_name: 'Chief Executive, ACME' }), {
      now: at(T.afterExpiry),
      subject: MARIA.id,
    });
    const id = bindingLevel({ subject: MARIA.id, priorConfirmedEdges: 4, attestation: stale });
    expect(id.level).toBe('1');
    expect(id.displayName).toBeNull();
    expect(id.render.name).toBe(shortKey(MARIA.id));
  });

  it('every downgrade path drops the name with the level', async () => {
    const cases: [string, VerifiedIdentity][] = [
      ['expired', bindingLevel({ subject: MARIA.id, attestation: attested(at(T.afterExpiry)) })],
      [
        'revoked',
        bindingLevel({
          subject: MARIA.id,
          attestation: verifyAttestation(attestation({ display_name: NAME }), {
            now: at(T.after),
            signedAt: at(T.after),
            revocations: [revocation()],
          }),
        }),
      ],
      [
        'anchor unreachable',
        bindingLevel({
          subject: MARIA.id,
          attestation: attested(at(T.afterExpiry)),
          anchor: await anchor(ORG.id, false),
        }),
      ],
    ];
    for (const [label, id] of cases) {
      expect(id.displayName, label).toBeNull();
      expect(id.hasName, label).toBe(false);
      expect(id.render.isKey, label).toBe(true);
    }
  });

  it('the illegal state has no constructor: only bindingLevel produces a VerifiedIdentity', () => {
    const id = bindingLevel({ subject: MARIA.id });
    const Ctor = id.constructor as new (...args: unknown[]) => unknown;
    // The class is exported for its type, but its constructor is private in TypeScript and
    // its only entry point is the static grader. Reaching it through `.constructor` at runtime
    // still cannot mint a name: the grader is the only path that reads one out of evidence.
    expect(() => new Ctor({ subject: MARIA.id, displayName: 'Anyone' })).toThrow();
    expect(Object.isFrozen(id)).toBe(true);
    // A frozen result cannot be upgraded after the fact either.
    expect(() => {
      (id as unknown as { displayName: string }).displayName = 'Anyone';
    }).toThrow();
  });

  it('no evidence combination yields a name below level 2', async () => {
    // Exhaustive over the evidence axes, rather than over hand-picked examples.
    const anchors = [null, await anchor(ORG.id), await anchor(ORG.id, false)];
    const attestations = [null, attested(), attested(at(T.afterExpiry))];
    const proofs = [null, proof()];
    for (const priors of [0, 1, 9]) {
      for (const a of attestations) {
        for (const an of anchors) {
          for (const p of proofs) {
            const id = bindingLevel({
              subject: MARIA.id,
              priorConfirmedEdges: priors,
              attestation: a,
              anchor: an,
              bindingProof: p,
            });
            if (id.displayName !== null) {
              expect(['2', '3']).toContain(id.level);
            } else {
              expect(id.render.isKey).toBe(true);
            }
          }
        }
      }
    }
  });
});

/**
 * The `verification-levels.json` oracle, replayed.
 *
 * This family had been vendored, counted by gate G0, and read by nothing — the same silence that
 * hid the §6.7 addressing family. G0 now fails when a vector file no test names, which is what
 * surfaced it.
 *
 * Worth recording: `ladder.ts` carries a comment marking the position of `ext` in the order as a
 * DECISION rather than a spec rule, because §1.6 ranked `ext` against nothing. The suite now
 * states `0 < 1 < ext < 2 < 3` with the same reasoning almost word for word — self-assertion must
 * not outrank a third party staking its own key. The local reading became the rule.
 */
describe('M-12: the ladder as the conformance suite states it', () => {
  const VECTORS = 'vendor/vectors/node-surface/verification-levels.json';

  interface LevelCase {
    name: string;
    evidence: {
      priorConfirmedEdge: boolean;
      bindingProof: boolean;
      attestation: boolean;
      domainAnchored: boolean;
      attestedDisplayName: string | null;
    };
    expected: { level: string; display_name: string | null; name_bearing: boolean };
  }
  const suite = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
    level_rank: Record<string, number>;
    name_bearing_levels: string[];
    cases: LevelCase[];
  };

  /** The oracle's abstract evidence, expressed as the verdicts this package's grader consumes. */
  function graded(e: LevelCase['evidence']): VerifiedIdentity {
    const att = e.attestation
      ? verifyAttestation(
          attestation(e.attestedDisplayName === null ? {} : { display_name: e.attestedDisplayName }),
          { now: at(T.before) },
        )
      : null;
    return bindingLevel({
      subject: MARIA.id,
      priorConfirmedEdges: e.priorConfirmedEdge ? 1 : 0,
      attestation: att,
      anchor: e.domainAnchored ? { ok: true, domain: 'acme.example', anchor: anchorDocument() as never } : null,
      bindingProof: e.bindingProof
        ? { ok: true, proof: { channel_url: 'https://example.com/maria' } as never, reason: null, detail: null }
        : null,
    });
  }

  it('replays every case the oracle states', () => {
    expect(suite.cases).toHaveLength(10);
  });

  it('reaches the oracle’s level and name on every case', () => {
    for (const c of suite.cases) {
      const id = graded(c.evidence);
      expect(id.level, c.name).toBe(c.expected.level);
      expect(id.displayName, c.name).toBe(c.expected.display_name);
      expect(id.hasName, c.name).toBe(c.expected.name_bearing);
    }
  });

  it('withholds a name that IS in the evidence, at every level that does not carry it', () => {
    // The three negative cases are the whole of M-12 on this layer: a display name sitting right
    // there in the surrounding data, and a level that has not earned it. A grader that read the
    // name from wherever it could find it would pass every positive case above.
    const negatives = suite.cases.filter((c) => c.evidence.attestedDisplayName !== null && !c.expected.name_bearing);
    expect(negatives.length).toBeGreaterThanOrEqual(3);
    for (const c of negatives) {
      const id = graded(c.evidence);
      expect(id.displayName, c.name).toBeNull();
      expect(id.render.isKey, c.name).toBe(true);
      expect(id.render.name, c.name).not.toContain('Maria');
    }
  });

  it('ranks the levels exactly as the oracle does', () => {
    for (const [level, rank] of Object.entries(suite.level_rank)) {
      expect(LEVEL_RANK[level as VerificationLevel], level).toBe(rank);
    }
    expect(suite.name_bearing_levels).toEqual(['2', '3']);
  });
});
