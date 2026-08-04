import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CROSS_PERSONA_APIS, ORDERING_KEY_FIELDS, ScopeViolation } from '@servanda/vault';
import { ServandaNode } from '../../src/node.js';
import { makeFixture, type Fixture } from '../support/fixture.js';

/**
 * M-5 — No org-context mixing in any pipeline; ordering of opaque items in the personal queue
 * is the sole exception. §5.3: "Cross-scope *ordering* of opaque items in a personal attention
 * queue is permitted; content transfer is not."
 *
 * Owned by this layer (vault scoping + brief).
 */

let fx: Fixture;
const ACME = 'acme secret: migrate the billing cluster';
const GLOBEX = 'globex secret: renegotiate the MSA';

beforeAll(() => {
  fx = makeFixture({
    personas: [
      { index: 0, label: 'acme', scope_kind: 'org' },
      { index: 1, label: 'globex', scope_kind: 'org' },
    ],
  });
  fx.node.commit({ intent: ACME, owed_to: null, due: null, persona: 'acme', propose: false });
  fx.node.commit({ intent: GLOBEX, owed_to: null, due: null, persona: 'globex', propose: false });
});
afterAll(() => fx.cleanup());

describe('M-5: no org-context mixing; ordering is the sole exception', () => {
  it('there is exactly one cross-persona read in the whole store', () => {
    expect(CROSS_PERSONA_APIS).toEqual(['listOrderingKeysAcrossPersonas']);
  });

  it('a query combining two org personas’ content is not expressible', () => {
    // The only shape a caller can name is one persona at a time. Asking persona A for
    // persona B's record returns nothing; asking for an unknown persona throws.
    const acmeHash = fx.vault.listCommitments(fx.personas[0]!)[0]!.hash;
    expect(fx.vault.getCommitment(fx.personas[1]!, acmeHash)).toBeNull();
    expect(() => fx.vault.listCommitments('0'.repeat(64))).toThrow(ScopeViolation);

    const acmeText = JSON.stringify(fx.vault.listCommitments(fx.personas[0]!));
    const globexText = JSON.stringify(fx.vault.listCommitments(fx.personas[1]!));
    expect(acmeText).toContain(ACME);
    expect(acmeText).not.toContain(GLOBEX);
    expect(globexText).toContain(GLOBEX);
    expect(globexText).not.toContain(ACME);
  });

  it('the escape hatch carries ordering keys and no content whatsoever', () => {
    const keys = fx.vault.listOrderingKeysAcrossPersonas();
    expect(new Set(keys.map((k) => k.persona)).size).toBe(2);
    for (const key of keys) {
      expect(Object.keys(key).sort()).toEqual([...ORDERING_KEY_FIELDS].sort());
    }
    const serialized = JSON.stringify(keys);
    expect(serialized).not.toContain(ACME);
    expect(serialized).not.toContain(GLOBEX);
  });

  it('brief orders across personas but each slot’s content comes from exactly one pipeline', () => {
    const brief = fx.node.brief({ persona: null });
    expect(brief.slots.length).toBeGreaterThanOrEqual(2);

    for (const slot of brief.slots) {
      expect(slot.persona).toBeDefined();
      // The headline must be readable from THAT persona's vault and no other.
      const own = JSON.stringify(fx.vault.listCommitments(slot.persona!));
      expect(own).toContain(slot.headline);
      const other = fx.vault
        .listPersonaIds()
        .filter((p) => p !== slot.persona)
        .map((p) => JSON.stringify(fx.vault.listCommitments(p)))
        .join('');
      expect(other).not.toContain(slot.headline);
    }
  });

  it('a single-persona brief never surfaces another persona’s content', () => {
    const acmeOnly = new ServandaNode({
      vault: fx.vault,
      localStore: fx.node.local,
      activePersona: fx.personas[0]!,
      now: () => fx.now,
    }).brief({ persona: 'acme' });
    expect(acmeOnly.slots.map((s) => s.headline)).toContain(ACME);
    expect(acmeOnly.slots.map((s) => s.headline)).not.toContain(GLOBEX);
    expect(new Set(acmeOnly.slots.map((s) => s.persona))).toEqual(new Set([fx.personas[0]!]));
  });

  it('open_loops does not fan out across personas (§7: brief is the only ordering point)', () => {
    const items = fx.node.openLoops({ view: 'all', persona: null, limit: 50 });
    expect(items.items.map((i) => i.intent_or_expect)).toContain(ACME);
    expect(items.items.map((i) => i.intent_or_expect)).not.toContain(GLOBEX);
  });
});
