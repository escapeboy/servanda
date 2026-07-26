import { describe, expect, it } from 'vitest';
import {
  assertPermitted,
  CapabilityError,
  CapabilitySet,
  matchesGlob,
  normalizeWorkspacePath,
  unifiedDiff,
  Workspace,
} from '../src/index.js';

const CAPS: CapabilitySet = CapabilitySet.parse({
  read: ['src/**', 'test/**'],
  write: ['test/**'],
  maxChangedLines: 100,
  maxChangedFiles: 2,
});

describe('capability paths', () => {
  it('refuses anything that could leave the workspace', () => {
    for (const bad of ['/etc/passwd', '../outside', 'src/../../outside', 'C:\\win', 'src\\x', '', '.']) {
      expect(() => normalizeWorkspacePath(bad), bad).toThrow(TypeError);
    }
    expect(normalizeWorkspacePath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeWorkspacePath('src//a.ts')).toBe('src/a.ts');
  });

  it('matches globs by segment, and ** across them', () => {
    expect(matchesGlob('src/a.ts', 'src/**')).toBe(true);
    expect(matchesGlob('src/deep/a.ts', 'src/**')).toBe(true);
    expect(matchesGlob('src/deep/a.ts', 'src/*')).toBe(false);
    expect(matchesGlob('package.json', 'package.json')).toBe(true);
    expect(matchesGlob('other/package.json', 'package.json')).toBe(false);
    expect(matchesGlob('.github/workflows/ci.yml', '.github/**')).toBe(true);
  });

  it('denies a read outside the world and a write outside the writable part of it', () => {
    expect(() => assertPermitted(CAPS, 'read', '.github/workflows/ci.yml')).toThrow(CapabilityError);
    expect(() => assertPermitted(CAPS, 'write', 'src/a.ts')).toThrow(CapabilityError);
    expect(assertPermitted(CAPS, 'read', 'src/a.ts')).toBe('src/a.ts');
    expect(assertPermitted(CAPS, 'write', 'test/a.test.ts')).toBe('test/a.test.ts');
  });
});

describe('workspace — the only world an executor has', () => {
  it('reads what it may and refuses what it may not', () => {
    const ws = new Workspace({ 'src/a.ts': 'export const a = 1;\n' }, CAPS);
    expect(ws.read('src/a.ts')).toContain('export const a');
    expect(ws.readOrNull('src/missing.ts')).toBeNull();
    expect(() => ws.read('.env')).toThrow(CapabilityError);
    expect(() => ws.write('src/a.ts', 'x')).toThrow(CapabilityError);
    expect(() => ws.write('../escape.ts', 'x')).toThrow(TypeError);
  });

  it('collects writes and deletes as a proposal, touching nothing', () => {
    const ws = new Workspace({ 'test/old.test.ts': 'old\n' }, CAPS);
    ws.write('test/new.test.ts', 'new\n');
    ws.delete('test/old.test.ts');
    expect(ws.proposal()).toEqual({ writes: { 'test/new.test.ts': 'new\n' }, deletes: ['test/old.test.ts'] });
    expect(ws.exists('test/old.test.ts')).toBe(false);
  });

  it('refuses a snapshot the host should never have built', () => {
    expect(() => new Workspace({ '.env': 'SECRET=1' }, CAPS)).toThrow(CapabilityError);
  });
});

describe('unified diff', () => {
  it('reports an addition', () => {
    const d = unifiedDiff('a.txt', null, 'one\ntwo\n');
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(0);
    expect(d.text).toContain('--- /dev/null');
    expect(d.text).toContain('+one');
  });

  it('reports a deletion', () => {
    const d = unifiedDiff('a.txt', 'one\n', null);
    expect(d.deletions).toBe(1);
    expect(d.text).toContain('+++ /dev/null');
  });

  it('reports a modification with bounded context', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    const before = `${lines.join('\n')}\n`;
    const after = `${lines.map((l) => (l === 'f' ? 'F' : l)).join('\n')}\n`;
    const d = unifiedDiff('a.txt', before, after);
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.text).toContain('-f');
    expect(d.text).toContain('+F');
    expect(d.text).toContain('@@');
    // Three lines of context each side; the far ends of the file are elided.
    expect(d.text).toContain(' c\n');
    expect(d.text).not.toContain(' a\n');
    expect(d.text).not.toContain(' l\n');
  });

  it('reports nothing for an unchanged file', () => {
    expect(unifiedDiff('a.txt', 'same\n', 'same\n')).toEqual({ text: '', additions: 0, deletions: 0 });
  });
});
