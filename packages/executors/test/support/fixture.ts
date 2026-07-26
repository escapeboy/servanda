import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutorCommitment } from '../../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..', '..', '..');
export const FIXTURE_REPO = join(REPO_ROOT, 'fixtures', 'archaeology-repo', 'repo');

/** Gate GB pins this. If the fixture is not at this commit, every path assertion below is void. */
export const FIXTURE_HEAD = '8779acbf1753fc5ddf67a3ae76434880d171a710';

export const PERSONA = 'a'.repeat(64);
export const OTHER_PERSONA = 'c'.repeat(64);

export const COMMITMENT: ExecutorCommitment = {
  v: 'servanda/0.1',
  type: 'commitment',
  owner: PERSONA,
  owed_to: null,
  due: null,
  conditions: [],
  created_at: '2026-01-01T00:00:00Z',
  source: 'archaeology',
  confidence: 0.9,
  commitment_hash: 'b'.repeat(64),
};

/**
 * A content hash of the fixture working tree. Executors are supposed to be incapable of writing
 * anywhere, so every test that runs one against the fixture compares this before and after: the
 * fixture is the oracle for gate GB as well, and a run that mutated it would corrupt that gate
 * silently.
 */
export function hashTree(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      hash.update(path.slice(root.length));
      hash.update('\0');
      hash.update(readFileSync(path));
      hash.update('\0');
      hash.update(String(statSync(path).size));
    }
  };
  walk(root);
  return hash.digest('hex');
}
