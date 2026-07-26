import type { Executor } from '../executor.js';

/**
 * Class `dep-bump` — move one dependency to one version in `package.json`.
 *
 * Two constraints shape this. It edits by targeted replacement rather than re-serialising the
 * parsed JSON, so the diff is one line and a reviewer can see the whole change at a glance;
 * re-emitting the file would reformat it and bury a supply-chain change in whitespace noise.
 * And it re-parses the result before proposing it — a manifest this executor broke is a manifest
 * nobody can install.
 *
 * Its ceiling is set in `trust/gradient.ts`, not here: a dependency bump introduces third-party
 * code that will run in CI and production, so no amount of history takes this class to silent.
 */

const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

const MANIFEST = 'package.json';

interface Manifest {
  [block: string]: unknown;
}

export const depBumpExecutor: Executor = (_commitment, context) => {
  if (context.target.kind !== 'dependency') return null;
  const { name, toVersion } = context.target;

  const raw = context.workspace.readOrNull(MANIFEST);
  if (raw === null) return null;

  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch {
    return null; // a manifest we cannot read is a manifest we must not rewrite
  }

  const block = DEPENDENCY_BLOCKS.find((b) => {
    const deps = manifest[b];
    return deps !== null && typeof deps === 'object' && name in (deps as Record<string, unknown>);
  });
  if (block === undefined) return null;

  const from = (manifest[block] as Record<string, unknown>)[name];
  if (typeof from !== 'string' || from === toVersion) return null;

  // Replace the exact `"name": "from"` pair, once. `escaped` keeps a package name with regex
  // metacharacters (scoped names contain `/`, some contain `.`) from becoming a pattern.
  const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pair = new RegExp(`("${escaped(name)}"\\s*:\\s*)"${escaped(from)}"`);
  if (!pair.test(raw)) return null;
  const next = raw.replace(pair, `$1"${toVersion}"`);

  let reparsed: Manifest;
  try {
    reparsed = JSON.parse(next) as Manifest;
  } catch {
    return null;
  }
  if ((reparsed[block] as Record<string, unknown>)[name] !== toVersion) return null;

  context.workspace.write(MANIFEST, next);

  return {
    title: `chore(deps): bump ${name} from ${from} to ${toVersion}`,
    body: [
      `Moves \`${name}\` in \`${block}\` from \`${from}\` to \`${toVersion}\`.`,
      '',
      'This executor changed a version string and nothing else. It did not fetch the package,',
      'read its changelog, or run anything — it has no network. Review the upstream diff',
      'yourself before merging: a dependency bump is third-party code you are about to run.',
    ].join('\n'),
  };
};
