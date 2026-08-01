import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyAssertionChain } from '@servanda/node';
import { EvidenceBundle } from '../../src/bundle.js';
import { GIT_ALLOWLIST, RefusedGitSubcommand, runGit } from '../../src/classes/git.js';
import { REGISTRY } from '../../src/registry.js';
import { verifyCommitment } from '../../src/verify.js';
import {
  assertion,
  commitment,
  edge,
  NOW,
  OWED_TO,
  OWNER,
  REPO,
  REPO_HEAD,
} from '../support/fixture.js';

/**
 * M-13 — "Agents are never parties: signing keys belong to personas/groups; automation acts
 * under, never as."
 *
 * An adapter is the sharpest test of this rule in the whole system, because it is the component
 * whose output *is* the fact of a kept promise. If an adapter could sign, then "verified" and
 * "asserted by the owner" would collapse into one act performed by software, and §4.4's whole
 * point — that a promise is closed by the person who made it — would be gone.
 *
 * So: an adapter observes. The bundle it returns cannot express a signature, the context it is
 * handed contains no key, and the edge does not move until a party signs.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('M-13: an adapter observes; it never signs', () => {
  it('produces a bundle that cannot carry a signature at all', () => {
    const outcome = verifyCommitment(commitment([{ kind: 'commit', value: REPO_HEAD }]), {
      now: NOW,
      repo: { path: REPO },
    });
    expect(outcome.verifiable).toBe(true);
    if (!outcome.verifiable) throw new Error('unreachable');

    // Not "rejected by a check" — not expressible. The schema is strict and has no such field.
    for (const extra of [
      { sig: 'f'.repeat(128) },
      { by: OWNER.personaId },
      { signed_by: OWNER.personaId },
      { state: 'closed' },
    ]) {
      expect(
        EvidenceBundle.safeParse({ ...outcome.bundle, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('reaches no key of any kind — the whole package never touches signing', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const forbidden of [
        /\bsignObject\b/,
        /\bwithSignature\b/,
        /\bprivate_key\b/,
        /\bprivateKey\b/,
        /\bderivePersona\b/,
        /@servanda\/vault/,
      ]) {
        expect(forbidden.test(text), `${file} matches ${forbidden}`).toBe(false);
      }
    }
  });

  it('observing does not move the edge — only a party’s signature does', () => {
    const e = edge({ closure_policy: 'on-evidence' });
    const open = [
      assertion({
        edge_id: e.edge_id,
        state: 'proposed',
        by: OWNER,
        asserted_at: '2026-07-01T09:00:00Z',
        evidence_hash: null,
      }),
      assertion({
        edge_id: e.edge_id,
        state: 'confirmed',
        by: OWED_TO,
        asserted_at: '2026-07-01T10:00:00Z',
        evidence_hash: null,
      }),
    ];

    const outcome = verifyCommitment(commitment([{ kind: 'commit', value: REPO_HEAD }]), {
      now: NOW,
      repo: { path: REPO },
      edge: e,
    });
    expect(outcome.verifiable && outcome.bundle.satisfied).toBe(true);

    // The promise is demonstrably kept. The edge is still open, because nobody has signed.
    expect(verifyAssertionChain(e, open).final_state).toBe('open');

    // And an assertion built from the bundle by anyone who is not a party is discarded, however
    // good the evidence is: an "adapter persona" is not a party to the edge (M-3, M-13).
    if (!outcome.verifiable) throw new Error('unreachable');
    const byAnAgent = assertion({
      edge_id: e.edge_id,
      state: 'closed',
      by: { personaId: 'f'.repeat(64), privateKey: OWNER.privateKey },
      asserted_at: NOW,
      evidence_hash: outcome.evidence_hash,
    });
    const verification = verifyAssertionChain(e, [...open, byAnAgent]);
    expect(verification.final_state).toBe('open');
    expect(verification.outcomes[2]?.accepted).toBe(false);
  });

  it('cannot act on the world either: git is read-only plumbing, allowlisted', () => {
    expect([...GIT_ALLOWLIST]).toEqual(['rev-parse', 'cat-file', 'merge-base']);
    for (const forbidden of ['commit', 'push', 'fetch', 'tag', 'update-ref', 'config']) {
      expect(() => runGit(REPO, [forbidden]), forbidden).toThrow(RefusedGitSubcommand);
    }
    // argv[0] is the subcommand, full stop. The tempting "helpful" version of this guard looks
    // past leading options to find the verb — and that version runs `git -c core.pager=sh
    // rev-parse`, which is an allowlisted subcommand carrying an arbitrary command with it. The
    // env scrub answers a config file; it does not answer `-c` on the command line. Nothing here
    // may be smuggled in front of the name.
    for (const smuggled of [
      ['-c', 'core.pager=sh', 'rev-parse'],
      ['--exec-path=/tmp', 'rev-parse'],
      ['-c', 'protocol.ext.allow=always', 'cat-file'],
      [],
    ]) {
      expect(() => runGit(REPO, smuggled), JSON.stringify(smuggled)).toThrow(RefusedGitSubcommand);
    }
  });

  it('every adapter is an observer — the interface has no verb that acts', () => {
    for (const adapter of REGISTRY) {
      expect(Object.keys(adapter).sort()).toEqual(['declares', 'name', 'observe', 'summary']);
    }
  });
});
