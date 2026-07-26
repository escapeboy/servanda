import type { Executor } from '../executor.js';

/**
 * Class `tests` — scaffold a test file for a source module.
 *
 * What it writes is deliberately modest: it asserts that the module's exported functions are
 * exported and callable. That is a scaffold a human fills in, not a claim of coverage, and the
 * artifact body says so. An executor that silently produced weak tests and called them coverage
 * would be worse than one that produced nothing.
 *
 * It never overwrites an existing test file. Replacing a human's tests is a correction of their
 * work, not an addition to it, and this class has no business doing that unasked.
 */

const EXPORTED_FUNCTION = /^export function ([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;

function moduleName(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.[cm]?[jt]sx?$/, '');
}

export const testsExecutor: Executor = (_commitment, context) => {
  if (context.target.kind !== 'source-file') return null;
  const sourcePath = context.target.path;
  const source = context.workspace.readOrNull(sourcePath);
  if (source === null) return null;

  EXPORTED_FUNCTION.lastIndex = 0;
  const names = [...source.matchAll(EXPORTED_FUNCTION)]
    .map((m) => m[1])
    .filter((n): n is string => n !== undefined);
  if (names.length === 0) return null;

  const name = moduleName(sourcePath);
  const testPath = `test/${name}.test.ts`;
  if (context.workspace.exists(testPath)) return null;

  const importPath = `../${sourcePath.replace(/\.ts$/, '.js')}`;
  const lines = [
    `import { describe, expect, it } from 'vitest';`,
    `import { ${names.join(', ')} } from '${importPath}';`,
    '',
    `describe('${name}', () => {`,
  ];
  for (const fn of names) {
    lines.push(`  it('exports ${fn}', () => {`);
    lines.push(`    expect(typeof ${fn}).toBe('function');`);
    lines.push('  });');
    lines.push('');
  }
  lines.push('});');

  context.workspace.write(testPath, `${lines.join('\n')}\n`);

  return {
    title: `test: scaffold tests for ${sourcePath}`,
    body: [
      `Adds \`${testPath}\` covering the ${names.length} exported function(s) of \`${sourcePath}\`:`,
      '',
      ...names.map((fn) => `- \`${fn}\``),
      '',
      'These assert the exports exist and are callable. They are a scaffold to fill in, not',
      'coverage — the behavioural assertions are yours to write.',
    ].join('\n'),
  };
};
