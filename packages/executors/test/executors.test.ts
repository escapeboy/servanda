import { describe, expect, it } from 'vitest';
import {
  DraftPrArtifact,
  EXECUTOR_CLASS_NAMES,
  getExecutorClass,
  REGISTRY,
  runExecutor,
  UnknownExecutorClass,
  Workspace,
} from '../src/index.js';
import { COMMITMENT, FIXTURE_HEAD, FIXTURE_REPO, hashTree, PERSONA } from './support/fixture.js';

const NOW = '2026-07-26T10:00:00Z';

describe('registry — three classes, hardcoded, no fourth door', () => {
  it('is exactly the v1 set', () => {
    expect([...EXECUTOR_CLASS_NAMES]).toEqual(['tests', 'dead-code', 'dep-bump']);
    expect(REGISTRY.map((c) => c.name)).toEqual(['tests', 'dead-code', 'dep-bump']);
  });

  it('exposes no way to add a class at runtime', async () => {
    // The asymmetry, mechanically: the door for signals is open, the door for actions is not.
    // There is no `register`, no `add`, no plugin loader — adding a class means editing the
    // registry and passing review.
    const registryModule = await import('../src/registry.js');
    const mutators = Object.keys(registryModule).filter((k) =>
      /^(register|add|install|load|use|extend)/i.test(k),
    );
    expect(mutators).toEqual([]);
    expect(() => getExecutorClass('workflow')).toThrow(UnknownExecutorClass);
    expect(() => getExecutorClass('email')).toThrow(/not extensible at runtime/);
    expect(Object.isFrozen(REGISTRY)).toBe(true);
    expect(() => {
      (REGISTRY as unknown as unknown[]).push({ name: 'workflow' });
    }).toThrow(TypeError);
  });

  it('grants no class a capability outside its own working area', () => {
    for (const executorClass of REGISTRY) {
      for (const glob of [...executorClass.capabilities.read, ...executorClass.capabilities.write]) {
        expect(glob.startsWith('.github'), `${executorClass.name}: ${glob}`).toBe(false);
        expect(glob.includes('..'), `${executorClass.name}: ${glob}`).toBe(false);
        expect(glob.startsWith('/'), `${executorClass.name}: ${glob}`).toBe(false);
      }
      expect(executorClass.capabilities.maxChangedFiles).toBeLessThanOrEqual(3);
    }
  });

  it('has no capability field in which network access could be expressed', () => {
    for (const executorClass of REGISTRY) {
      expect(Object.keys(executorClass.capabilities).sort()).toEqual([
        'maxChangedFiles',
        'maxChangedLines',
        'read',
        'write',
      ]);
    }
  });
});

describe('class dead-code — on the fixture', () => {
  it('proposes removing the dead flag, and nothing else', async () => {
    const before = hashTree(FIXTURE_REPO);
    const outcome = await runExecutor({
      executorClass: 'dead-code',
      commitment: COMMITMENT,
      target: { kind: 'symbol', symbol: 'FEATURE_LEGACY_IMPORT', path: 'src/flags.ts' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      now: NOW,
      intentForReviewer: 'clean up the legacy import flag',
    });

    expect(outcome.kind).toBe('artifact');
    if (outcome.kind !== 'artifact') throw new Error('unreachable');
    const artifact = outcome.artifact;

    expect(DraftPrArtifact.safeParse(artifact).success).toBe(true);
    expect(artifact.draft).toBe(true);
    expect(artifact.base.base_commit).toBe(FIXTURE_HEAD);
    expect(artifact.base.base_branch).toBe('main');
    expect(artifact.branch).toBe('servanda/dead-code/bbbbbbbbbbbb');
    expect(artifact.title).toBe('refactor: remove unused FEATURE_LEGACY_IMPORT');

    // Changed only what its class permits: one file, inside `src/**`.
    expect(artifact.changes.map((c) => c.path)).toEqual(['src/flags.ts']);
    expect(artifact.changes[0]?.kind).toBe('modified');
    expect(artifact.changes[0]?.additions).toBe(0);
    expect(artifact.changes[0]?.deletions).toBe(3);
    expect(artifact.diff).toContain('-export const FEATURE_LEGACY_IMPORT = false;');
    expect(artifact.diff).not.toContain('-export const FEATURE_NEW_CHECKOUT');
    expect(artifact.body).toContain('clean up the legacy import flag');

    expect(hashTree(FIXTURE_REPO)).toBe(before);
  });

  it('refuses the live flag — a second reference means it is not dead', async () => {
    const outcome = await runExecutor({
      executorClass: 'dead-code',
      commitment: COMMITMENT,
      target: { kind: 'symbol', symbol: 'FEATURE_NEW_CHECKOUT', path: 'src/flags.ts' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      now: NOW,
    });
    expect(outcome.kind).toBe('nothing-to-do');
  });

  it('refuses a symbol it cannot find', async () => {
    const outcome = await runExecutor({
      executorClass: 'dead-code',
      commitment: COMMITMENT,
      target: { kind: 'symbol', symbol: 'NOT_PRESENT', path: 'src/flags.ts' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      now: NOW,
    });
    expect(outcome.kind).toBe('nothing-to-do');
  });
});

describe('class tests — on the fixture', () => {
  it('scaffolds a test file for a source module, writing only under test/', async () => {
    const before = hashTree(FIXTURE_REPO);
    const outcome = await runExecutor({
      executorClass: 'tests',
      commitment: COMMITMENT,
      target: { kind: 'source-file', path: 'src/clean.ts' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      now: NOW,
    });

    expect(outcome.kind).toBe('artifact');
    if (outcome.kind !== 'artifact') throw new Error('unreachable');
    expect(outcome.artifact.changes.map((c) => c.path)).toEqual(['test/clean.test.ts']);
    expect(outcome.artifact.changes[0]?.kind).toBe('added');
    expect(outcome.artifact.diff).toContain("import { add, clamp } from '../src/clean.js';");
    expect(outcome.artifact.body).toContain('not');
    expect(hashTree(FIXTURE_REPO)).toBe(before);
  });

  it('finds nothing to do for a module with no exported functions', async () => {
    const outcome = await runExecutor({
      executorClass: 'tests',
      commitment: COMMITMENT,
      target: { kind: 'source-file', path: 'src/flags.ts' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      now: NOW,
    });
    expect(outcome.kind).toBe('nothing-to-do');
  });

  it('refuses a target of the wrong kind', async () => {
    const outcome = await runExecutor({
      executorClass: 'tests',
      commitment: COMMITMENT,
      target: { kind: 'dependency', name: 'zod', toVersion: '3.25.76' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      now: NOW,
    });
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') throw new Error('unreachable');
    expect(outcome.reason).toContain('takes a source-file target');
  });
});

describe('class dep-bump — over a snapshot', () => {
  const capabilities = getExecutorClass('dep-bump').capabilities;
  const manifest = JSON.stringify(
    { name: 'fixture-service', dependencies: { zod: '^3.24.0' }, devDependencies: { vitest: '^3.0.0' } },
    null,
    2,
  );

  function bump(snapshot: Record<string, string>, name: string, toVersion: string) {
    const workspace = new Workspace(snapshot, capabilities);
    const output = getExecutorClass('dep-bump').run(COMMITMENT, {
      persona: PERSONA,
      target: { kind: 'dependency', name, toVersion },
      workspace,
      now: NOW,
    });
    return { output, proposal: workspace.proposal() };
  }

  it('moves one version string and leaves the rest of the manifest alone', () => {
    const { output, proposal } = bump({ 'package.json': manifest }, 'zod', '3.25.76');
    expect(output?.title).toBe('chore(deps): bump zod from ^3.24.0 to 3.25.76');
    const next = proposal.writes['package.json'] as string;
    expect(JSON.parse(next).dependencies.zod).toBe('3.25.76');
    expect(JSON.parse(next).devDependencies.vitest).toBe('^3.0.0');
    // One line changed, not a reformat of the whole file.
    expect(next.split('\n').length).toBe(manifest.split('\n').length);
  });

  it('finds nothing to do for a dependency that is absent or already there', () => {
    expect(bump({ 'package.json': manifest }, 'left-pad', '1.0.0').output).toBeNull();
    expect(bump({ 'package.json': manifest }, 'zod', '^3.24.0').output).toBeNull();
  });

  it('refuses to rewrite a manifest it cannot parse', () => {
    expect(bump({ 'package.json': '{ not json' }, 'zod', '3.25.76').output).toBeNull();
  });

  it('finds nothing to do when the repository has no manifest (the fixture)', async () => {
    const outcome = await runExecutor({
      executorClass: 'dep-bump',
      commitment: COMMITMENT,
      target: { kind: 'dependency', name: 'zod', toVersion: '3.25.76' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      now: NOW,
    });
    expect(outcome.kind).toBe('nothing-to-do');
  });
});
