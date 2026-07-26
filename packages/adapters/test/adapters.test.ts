import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@servanda/crypto';
import { ciAdapter } from '../src/classes/ci.js';
import { fileAdapter } from '../src/classes/file.js';
import { gitAdapter, GIT_ALLOWLIST, RefusedGitSubcommand, runGit } from '../src/classes/git.js';
import { adapterFor, OBSERVABLE_REF_KINDS, REGISTRY } from '../src/registry.js';
import { parseCommitRef, parseFileRef } from '../src/refs.js';
import { ciEnvelope, commitment, NOW, REPO, REPO_HEAD, workspace } from './support/fixture.js';

const c = commitment([]);
const ref = (kind: 'commit' | 'file' | 'envelope' | 'url', value: string) => ({ kind, value });

describe('the registry is hardcoded and small', () => {
  it('is exactly ci, git, file', () => {
    expect(REGISTRY.map((a) => a.name)).toEqual(['ci', 'git', 'file']);
  });

  it('speaks to envelope, commit and file refs — and to no url', () => {
    expect([...OBSERVABLE_REF_KINDS].sort()).toEqual(['commit', 'envelope', 'file']);
    expect(adapterFor('url')).toBeUndefined();
  });

  it('every adapter refuses a ref kind it did not declare', () => {
    for (const adapter of REGISTRY) {
      for (const kind of ['envelope', 'commit', 'file', 'url'] as const) {
        if (adapter.declares.includes(kind)) continue;
        const outcome = adapter.observe(c, ref(kind, 'x'), { now: NOW });
        expect(outcome.verifiable, `${adapter.name} ← ${kind}`).toBe(false);
      }
    }
  });
});

describe('the ref grammar refuses rather than guesses', () => {
  it('parses the three commit forms', () => {
    expect(parseCommitRef(ref('commit', REPO_HEAD))).toEqual({ kind: 'commit', commit: REPO_HEAD });
    expect(parseCommitRef(ref('commit', 'branch:main'))).toEqual({ kind: 'branch', branch: 'main' });
    expect(parseCommitRef(ref('commit', 'merged:topic..main'))).toEqual({
      kind: 'merged',
      head: 'topic',
      base: 'main',
    });
  });

  it('refuses a ref name that could become an argument', () => {
    for (const bad of ['branch:--upload-pack=sh', 'branch:a b', 'branch:a^{}', 'branch:-x', 'nope']) {
      expect(() => parseCommitRef(ref('commit', bad)), bad).toThrow();
    }
  });

  it('refuses a path that could leave the workspace', () => {
    for (const bad of ['/etc/passwd', '../../etc/passwd', 'a/../../b', 'C:\\x', 'a\\b', '']) {
      expect(() => parseFileRef(ref('file', bad)), bad).toThrow();
    }
    expect(parseFileRef(ref('file', './src/flags.ts'))).toEqual({
      path: 'src/flags.ts',
      expectedSha256: null,
    });
    expect(parseFileRef(ref('file', `x.txt#sha256=${'a'.repeat(64)}`))).toEqual({
      path: 'x.txt',
      expectedSha256: 'a'.repeat(64),
    });
    expect(() => parseFileRef(ref('file', 'x.txt#md5=abc'))).toThrow();
  });
});

describe('git: read-only, offline, allowlisted', () => {
  it('runs only local plumbing', () => {
    expect([...GIT_ALLOWLIST]).toEqual(['rev-parse', 'cat-file', 'merge-base']);
    for (const forbidden of ['fetch', 'clone', 'ls-remote', 'push', 'pull', 'submodule', 'remote']) {
      expect(() => runGit(REPO, [forbidden]), forbidden).toThrow(RefusedGitSubcommand);
    }
  });

  it('observes a branch and its head', () => {
    const outcome = gitAdapter.observe(c, ref('commit', 'branch:main'), {
      now: NOW,
      repo: { path: REPO },
    });
    expect(outcome.verifiable).toBe(true);
    if (!outcome.verifiable) throw new Error('unreachable');
    expect(outcome.bundle.satisfied).toBe(true);
    expect(outcome.bundle.observations[0]).toEqual({
      kind: 'git-branch',
      branch: 'main',
      head: REPO_HEAD,
      present: true,
    });
  });

  it('observes a commit that is absent as absent, not as unverifiable', () => {
    const outcome = gitAdapter.observe(c, ref('commit', 'f'.repeat(40)), {
      now: NOW,
      repo: { path: REPO },
    });
    expect(outcome.verifiable).toBe(true);
    if (!outcome.verifiable) throw new Error('unreachable');
    expect(outcome.bundle.satisfied).toBe(false);
  });

  it('observes a merge as reachability in the local object graph', () => {
    const merged = gitAdapter.observe(c, ref('commit', 'merged:main..main'), {
      now: NOW,
      repo: { path: REPO },
    });
    expect(merged.verifiable && merged.bundle.satisfied).toBe(true);
    const unmerged = gitAdapter.observe(c, ref('commit', 'merged:nope..main'), {
      now: NOW,
      repo: { path: REPO },
    });
    expect(unmerged.verifiable && unmerged.bundle.satisfied).toBe(false);
  });

  it('is not verifiable when no repository was handed to it', () => {
    const outcome = gitAdapter.observe(c, ref('commit', 'branch:main'), { now: NOW });
    expect(outcome.verifiable).toBe(false);
    if (outcome.verifiable) throw new Error('unreachable');
    expect(outcome.reason).toBe('adapter-capability-absent');
    expect(outcome.evidence_hash).toBeNull();
  });
});

describe('file: rooted and read-only', () => {
  const ws = workspace({ 'report.md': 'done\n' });
  afterAll(() => ws.cleanup());
  const digest = sha256Hex(new TextEncoder().encode('done\n'));

  it('observes a present file and its digest', () => {
    const outcome = fileAdapter.observe(c, ref('file', 'report.md'), {
      now: NOW,
      workspace: { root: ws.root },
    });
    expect(outcome.verifiable).toBe(true);
    if (!outcome.verifiable) throw new Error('unreachable');
    expect(outcome.bundle.observations[0]).toMatchObject({ present: true, sha256: digest });
    expect(outcome.bundle.satisfied).toBe(true);
  });

  it('compares a named digest, and says so when it does not match', () => {
    const ok = fileAdapter.observe(c, ref('file', `report.md#sha256=${digest}`), {
      now: NOW,
      workspace: { root: ws.root },
    });
    expect(ok.verifiable && ok.bundle.satisfied).toBe(true);
    const bad = fileAdapter.observe(c, ref('file', `report.md#sha256=${'0'.repeat(64)}`), {
      now: NOW,
      workspace: { root: ws.root },
    });
    expect(bad.verifiable).toBe(true);
    if (!bad.verifiable) throw new Error('unreachable');
    expect(bad.bundle.satisfied).toBe(false);
    expect(bad.bundle.observations[0]).toMatchObject({ digest_matches: false });
  });

  it('records an absent file as an observation, not as a failure to observe', () => {
    const outcome = fileAdapter.observe(c, ref('file', 'never-written.md'), {
      now: NOW,
      workspace: { root: ws.root },
    });
    expect(outcome.verifiable).toBe(true);
    if (!outcome.verifiable) throw new Error('unreachable');
    expect(outcome.bundle.satisfied).toBe(false);
    expect(outcome.bundle.observations[0]).toMatchObject({ present: false, sha256: null });
  });
});

describe('ci: an already-received envelope, never a fetch', () => {
  const envelopes = [ciEnvelope()];

  it('observes a check run conclusion', () => {
    const outcome = ciAdapter.observe(c, ref('envelope', 'c'.repeat(64)), { now: NOW, envelopes });
    expect(outcome.verifiable).toBe(true);
    if (!outcome.verifiable) throw new Error('unreachable');
    expect(outcome.bundle.satisfied).toBe(true);
    expect(outcome.bundle.observations[0]).toMatchObject({
      kind: 'ci-run',
      conclusion: 'success',
      run_id: '99123',
      commit: REPO_HEAD,
    });
  });

  it('records a failed run as evidence rather than hiding it', () => {
    const failed = [ciEnvelope({ payload: { ...ciEnvelope().payload, conclusion: 'failure' } })];
    const outcome = ciAdapter.observe(c, ref('envelope', 'c'.repeat(64)), {
      now: NOW,
      envelopes: failed,
    });
    expect(outcome.verifiable).toBe(true);
    if (!outcome.verifiable) throw new Error('unreachable');
    expect(outcome.bundle.satisfied).toBe(false);
  });

  it('cannot observe an envelope that has not been received', () => {
    const outcome = ciAdapter.observe(c, ref('envelope', 'd'.repeat(64)), { now: NOW, envelopes });
    expect(outcome.verifiable).toBe(false);
    if (outcome.verifiable) throw new Error('unreachable');
    expect(outcome.reason).toBe('adapter-capability-absent');
  });

  it('refuses a non-CI envelope and one carrying no conclusion', () => {
    const notCi = [ciEnvelope({ source: 'chat' })];
    expect(ciAdapter.observe(c, ref('envelope', 'c'.repeat(64)), { now: NOW, envelopes: notCi })
      .verifiable).toBe(false);
    const noConclusion = [
      ciEnvelope({ payload: { ...ciEnvelope().payload, conclusion: undefined } }),
    ];
    const outcome = ciAdapter.observe(c, ref('envelope', 'c'.repeat(64)), {
      now: NOW,
      envelopes: noConclusion,
    });
    expect(outcome.verifiable).toBe(false);
    if (outcome.verifiable) throw new Error('unreachable');
    expect(outcome.reason).toBe('evidence-not-observable');
  });
});
