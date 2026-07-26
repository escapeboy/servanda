import type { Executor } from '../executor.js';

/**
 * Class `dead-code` — remove a declaration that nothing references.
 *
 * The safety of this class rests entirely on the liveness check, so it is deliberately
 * conservative: the symbol must appear exactly once across everything the executor can read, and
 * that one occurrence must be its own declaration. Any second occurrence anywhere — another
 * file, a comment, a string — means the executor returns `null` and the human never sees a
 * proposal. The fixture encodes both sides of that: `FEATURE_LEGACY_IMPORT` is declared and
 * never read, while `FEATURE_NEW_CHECKOUT` is read from a second file and must stay.
 *
 * A false negative here costs nothing; a false positive deletes working code. The asymmetry is
 * the whole design.
 */

function wordOccurrences(text: string, symbol: string): number {
  const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  return (text.match(re) ?? []).length;
}

const DECLARATION = (symbol: string): RegExp =>
  new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var|function|class)\\s+${symbol}\\b`);

export const deadCodeExecutor: Executor = (_commitment, context) => {
  if (context.target.kind !== 'symbol') return null;
  const { symbol, path } = context.target;

  const target = context.workspace.readOrNull(path);
  if (target === null) return null;

  // Liveness: any occurrence outside the declaration file means it is not dead.
  let elsewhere = 0;
  for (const other of context.workspace.list()) {
    if (other === path) continue;
    elsewhere += wordOccurrences(context.workspace.read(other), symbol);
  }
  if (elsewhere > 0) return null;

  const lines = target.split('\n');
  const declarationIndex = lines.findIndex((line) => DECLARATION(symbol).test(line));
  if (declarationIndex < 0) return null;

  // The declaration must be the only mention in its own file too — a self-reference means the
  // symbol is used, and a multi-line declaration is beyond what this class will touch.
  if (wordOccurrences(target, symbol) !== 1) return null;
  const declarationLine = lines[declarationIndex] as string;
  if (!/[;}]\s*$/.test(declarationLine.trim()) && !declarationLine.trim().endsWith(';')) {
    return null;
  }

  // Take the comment block immediately above it: it documents the thing being removed, so
  // leaving it behind would be leaving a different kind of dead code.
  let from = declarationIndex;
  while (from > 0) {
    const previous = (lines[from - 1] as string).trim();
    if (previous.startsWith('//') || previous.startsWith('*') || previous.startsWith('/*')) {
      from--;
      continue;
    }
    break;
  }

  let to = declarationIndex + 1;
  // Collapse one trailing blank line so the removal does not leave a double gap.
  if ((lines[to] ?? '').trim() === '' && from > 0 && (lines[from - 1] ?? '').trim() === '') to++;

  const removed = lines.slice(from, to);
  const next = [...lines.slice(0, from), ...lines.slice(to)];
  context.workspace.write(path, next.join('\n'));

  return {
    title: `refactor: remove unused ${symbol}`,
    body: [
      `\`${symbol}\` is declared in \`${path}\` and referenced nowhere else in the paths this`,
      `executor can read. Removing the declaration${removed.length > 1 ? ' and its comment' : ''}:`,
      '',
      '```',
      ...removed,
      '```',
      '',
      'Check the liveness claim against anything outside this executor\'s read capability —',
      'dynamic lookups, generated code, and other repositories are not visible to it.',
    ].join('\n'),
  };
};
