import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { sha256Hex } from '@servanda/crypto';
import { PROTOCOL_VERSION } from '@servanda/types';
import type { EvidenceRef } from '@servanda/types';
import type { AdapterCommitment, ObservationContext, VerificationAdapter } from '../adapter.js';
import { notVerifiable, observed } from '../adapter.js';
import type { Observation } from '../bundle.js';
import { MalformedRef, parseFileRef } from '../refs.js';

/**
 * The `file` adapter: does this path exist, and does it match a digest?
 *
 * Read-only, and rooted. `refs.ts` has already refused an absolute path and any `..`, but a
 * symlink inside the workspace could still point out of it, so the resolved real path is
 * checked against the resolved real root before a byte is read. A path that escapes is refused
 * as an observation, not silently clamped back inside — clamping would turn an attempted escape
 * into a successful observation of the wrong file.
 */

function withinRoot(root: string, path: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}

export const fileAdapter: VerificationAdapter = {
  name: 'file',
  declares: ['file'],
  summary: 'Observe that a path exists under the workspace root and what its digest is.',

  observe(commitment: AdapterCommitment, ref: EvidenceRef, context: ObservationContext) {
    if (ref.kind !== 'file') {
      return notVerifiable('no-adapter-for-evidence', `file does not observe ${ref.kind} refs`);
    }

    let parsed;
    try {
      parsed = parseFileRef(ref);
    } catch (err) {
      if (err instanceof MalformedRef) return notVerifiable('malformed-evidence-ref', err.message);
      throw err;
    }

    const root = context.workspace?.root;
    if (root === undefined) {
      return notVerifiable('adapter-capability-absent', 'no workspace was provided to observe');
    }

    let realRoot: string;
    try {
      realRoot = realpathSync(resolvePath(root));
    } catch {
      return notVerifiable('adapter-capability-absent', `workspace root ${root} does not exist`);
    }

    const target = resolvePath(realRoot, parsed.path);
    let observation: Observation;

    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      // Absent is a real observation, not a failure to observe: it is how "the promised file was
      // never written" gets recorded.
      observation = {
        kind: 'file',
        path: parsed.path,
        present: false,
        size: null,
        sha256: null,
        expected_sha256: parsed.expectedSha256,
        digest_matches: parsed.expectedSha256 === null ? null : false,
      };
      return bundleFor(commitment, context, observation);
    }

    if (!withinRoot(realRoot, real)) {
      return notVerifiable(
        'malformed-evidence-ref',
        `${parsed.path} resolves outside the workspace root`,
      );
    }
    const stat = statSync(real);
    if (!stat.isFile()) {
      return notVerifiable('evidence-not-observable', `${parsed.path} is not a regular file`);
    }

    const digest = sha256Hex(new Uint8Array(readFileSync(real)));
    observation = {
      kind: 'file',
      path: parsed.path,
      present: true,
      size: stat.size,
      sha256: digest,
      expected_sha256: parsed.expectedSha256,
      digest_matches: parsed.expectedSha256 === null ? null : parsed.expectedSha256 === digest,
    };
    return bundleFor(commitment, context, observation);
  },
};

function bundleFor(
  commitment: AdapterCommitment,
  context: ObservationContext,
  observation: Observation & { kind: 'file' },
) {
  return observed({
    v: PROTOCOL_VERSION,
    type: 'evidence_bundle',
    adapters: ['file'],
    commitment_hash: commitment.commitment_hash,
    observed_at: context.now,
    satisfied:
      observation.present && (observation.digest_matches === null || observation.digest_matches),
    observations: [observation],
  });
}
