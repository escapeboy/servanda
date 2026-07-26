/**
 * Unified diff, computed in-process.
 *
 * The executor layer never shells out to `git diff`. An executor that could spawn a process
 * could spawn `git push`, and the whole point of §9.2 is that the artifact is data a human
 * reviews, not an action already taken. So the diff is computed here, from two strings.
 */

export interface FileChange {
  readonly path: string;
  readonly kind: 'added' | 'modified' | 'deleted';
  readonly additions: number;
  readonly deletions: number;
}

interface Op {
  readonly kind: ' ' | '-' | '+';
  readonly text: string;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Classic LCS table. Inputs here are single source files, so the quadratic cost is fine. */
function lcs(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i] as number[];
      const next = table[i + 1] as number[];
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] as string });
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: '-', text: a[i] as string });
      i++;
    } else {
      ops.push({ kind: '+', text: b[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ kind: '-', text: a[i++] as string });
  while (j < m) ops.push({ kind: '+', text: b[j++] as string });
  return ops;
}

const CONTEXT = 3;

export interface DiffResult {
  readonly text: string;
  readonly additions: number;
  readonly deletions: number;
}

/** A unified diff for one file. `before === null` means added, `after === null` means deleted. */
export function unifiedDiff(path: string, before: string | null, after: string | null): DiffResult {
  const a = before === null ? [] : splitLines(before);
  const b = after === null ? [] : splitLines(after);
  const ops = lcs(a, b);

  const additions = ops.filter((o) => o.kind === '+').length;
  const deletions = ops.filter((o) => o.kind === '-').length;
  if (additions === 0 && deletions === 0) return { text: '', additions: 0, deletions: 0 };

  // Which ops are within CONTEXT lines of a change; the rest is elided.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === ' ') return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k++) {
      keep[k] = true;
    }
  });

  const lines: string[] = [
    `--- ${before === null ? '/dev/null' : `a/${path}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${path}`}`,
  ];

  let oldLine = 1;
  let newLine = 1;
  let index = 0;
  while (index < ops.length) {
    if (!keep[index]) {
      const op = ops[index] as Op;
      if (op.kind !== '+') oldLine++;
      if (op.kind !== '-') newLine++;
      index++;
      continue;
    }
    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (index < ops.length && keep[index]) {
      const op = ops[index] as Op;
      body.push(`${op.kind}${op.text}`);
      if (op.kind !== '+') {
        oldLine++;
        oldCount++;
      }
      if (op.kind !== '-') {
        newLine++;
        newCount++;
      }
      index++;
    }
    lines.push(`@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@`);
    lines.push(...body);
  }

  return { text: `${lines.join('\n')}\n`, additions, deletions };
}
