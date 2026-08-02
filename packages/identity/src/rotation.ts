import { publicKeyFromPrivate, verifyObject, withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, Rotation, RotationCanonical } from '@servanda/types';

/**
 * §1.7 — rotation. The object with the largest blast radius in the protocol: a rotation that
 * verifies moves every open edge of `old` onto `new`. Everything here fails closed.
 *
 * RESOLVED UPSTREAM (servanda-protocol#17), and both halves of the original problem moved.
 *
 * §1.7 named the signature fields `sig_old` / `sig_new?` while §0's rule excluded only a field
 * literally named `sig`, so `sig_old` had no defined preimage — it would have covered itself.
 * §0 now removes every member named `sig` or beginning with `sig_`, which gives `sig_old` the
 * same preimage `sig` has; and §1.7 has withdrawn the two-field encoding outright.
 *
 * So the "documented, non-normative preimage" this opt-in used to select is now simply the
 * normative one, and the behaviour below is no longer an interpretation — it is interoperability
 * with statements written before the withdrawal:
 *
 *   - the form this implementation EMITS is a single `sig` by the old key, which §1.7 makes a MUST;
 *   - a rotation carrying only `sig_old` PARSES so that it can be REPORTED rather than mistaken
 *     for corrupt, and does not verify by default — `legacy-sig-old-encoding-unverifiable`;
 *   - accepting it requires an explicit opt-in (`acceptLegacySigOld`), still off by default, so
 *     no continuity ever transfers on a withdrawn encoding by accident.
 *
 * `sig_new` is never sufficient on its own under any option. A rotation signed only by the
 * key it hands control TO is the takeover this object exists to prevent.
 */

export type RotationRejection =
  | 'malformed'
  /** `old` and `new` are the same key: nothing to transfer, and a free replay of any sig. */
  | 'self-rotation'
  /** No signature by the old key is present at all (only `sig_new`, or none). */
  | 'missing-old-key-signature'
  /** A signature is present but does not verify against `old`. */
  | 'not-signed-by-old-key'
  /** Only the §1.7 `sig_old` encoding is present and the caller did not opt in. */
  | 'legacy-sig-old-encoding-unverifiable';

export interface VerifyRotationOptions {
  /**
   * Accept the withdrawn §1.7 `sig_old` encoding, under the §0 preimage described above.
   * OFF by default. Turning it on widens what can move your open edges.
   */
  readonly acceptLegacySigOld?: boolean;
}

export type RotationVerdict =
  | {
      readonly ok: true;
      readonly rotation: Rotation;
      readonly old: string;
      readonly new: string;
      /** Which encoding carried the old key's signature. */
      readonly encoding: 'sig' | 'sig_old';
    }
  | {
      readonly ok: false;
      readonly reason: RotationRejection;
      readonly detail: string | null;
    };

/**
 * The rotation core: every field except the signature fields — which is what §0's rule produces
 * for this object, since it strips `sig` and every `sig_*`. Kept as a named function because the
 * opt-in legacy path needs to name the preimage it verifies against, and because writing it out
 * shows that the legacy and current encodings cover identical bytes, which is the whole reason
 * §1.7 could withdraw one of them.
 */
export function rotationCore(r: Rotation): {
  v: typeof PROTOCOL_VERSION;
  type: 'rotation';
  old: string;
  new: string;
  rotated_at: string;
} {
  return { v: r.v, type: r.type, old: r.old, new: r.new, rotated_at: r.rotated_at };
}

export function verifyRotation(input: unknown, options: VerifyRotationOptions = {}): RotationVerdict {
  const parsed = Rotation.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed', detail: parsed.error.issues[0]?.message ?? null };
  }
  const r = parsed.data;

  if (r.old === r.new) {
    return { ok: false, reason: 'self-rotation', detail: 'old and new are the same key' };
  }

  if (r.sig !== undefined) {
    // The universal rule, applied literally: the preimage is the object minus `sig`. If the
    // object also carries sig_old/sig_new they are part of that preimage, so they cannot be
    // stripped or swapped without invalidating `sig`.
    if (!verifyObject(r, r.old)) {
      return {
        ok: false,
        reason: 'not-signed-by-old-key',
        detail: `sig does not verify against old key ${r.old}`,
      };
    }
    return { ok: true, rotation: r, old: r.old, new: r.new, encoding: 'sig' };
  }

  if (r.sig_old === undefined) {
    // Reachable only if the schema refine is ever loosened; kept so the reason exists.
    return { ok: false, reason: 'missing-old-key-signature', detail: 'no sig and no sig_old' };
  }

  if (options.acceptLegacySigOld !== true) {
    return {
      ok: false,
      reason: 'legacy-sig-old-encoding-unverifiable',
      detail: '§1.7 sig_old has no signing preimage defined by the spec (protocol issue #17)',
    };
  }

  // sha256(JCS(core)) is exactly what `verifyObject` hashes for an object whose only extra field
  // is `sig` — and, since §0's rule now strips `sig_*` too, exactly what it hashes for the legacy
  // object as it stands. No second signing implementation, and no preimage invented here.
  if (!verifyObject({ ...rotationCore(r), sig: r.sig_old }, r.old)) {
    return {
      ok: false,
      reason: 'not-signed-by-old-key',
      detail: `sig_old does not verify against old key ${r.old}`,
    };
  }
  return { ok: true, rotation: r, old: r.old, new: r.new, encoding: 'sig_old' };
}

/** Emit a rotation in the only encoding with a spec-defined preimage: one `sig` by `old`. */
export function signRotation(input: {
  readonly oldPrivateKey: string;
  readonly newPublicKey: string;
  readonly rotatedAt: string;
}): RotationCanonical {
  const core = {
    v: PROTOCOL_VERSION,
    type: 'rotation' as const,
    old: publicKeyFromPrivate(input.oldPrivateKey),
    new: input.newPublicKey,
    rotated_at: input.rotatedAt,
  };
  return RotationCanonical.parse(withSignature(core, input.oldPrivateKey));
}

export type SuccessorStop = 'end' | 'fork' | 'cycle' | 'depth';

export interface SuccessorResolution {
  /** The key the caller asked about. */
  readonly key: string;
  /**
   * The key that now holds this identity's open edges. Equals `key` when nothing verified.
   * §1.7: "Verifiers MUST treat `new` as the successor for all open edges of `old`."
   */
  readonly current: string;
  /** The verified rotations applied, oldest first. */
  readonly chain: readonly Rotation[];
  /** Rotations that did not verify, with why. Never applied; surfaced so they can be shown. */
  readonly rejected: readonly { readonly input: unknown; readonly reason: RotationRejection }[];
  readonly stoppedBecause: SuccessorStop;
}

/** A chain longer than this is not a rotation history, it is an attack or a bug. */
export const MAX_ROTATION_DEPTH = 32;

/**
 * Resolve the successor of `key` across a set of rotation statements.
 *
 * Only verified rotations move the key. A fork — two different verified rotations from the
 * same `old` — stops resolution where it forked: §1.7 gives no rule for choosing between two
 * signed successors, and picking one would let anyone who ever held the old key re-point an
 * identity by publishing a second rotation. Stopping is the reading that refuses.
 */
export function resolveSuccessor(
  key: string,
  rotations: readonly unknown[],
  options: VerifyRotationOptions = {},
): SuccessorResolution {
  const edges = new Map<string, Map<string, Rotation>>();
  const rejected: { input: unknown; reason: RotationRejection }[] = [];

  for (const raw of rotations) {
    const verdict = verifyRotation(raw, options);
    if (!verdict.ok) {
      rejected.push({ input: raw, reason: verdict.reason });
      continue;
    }
    const byNew = edges.get(verdict.old) ?? new Map<string, Rotation>();
    byNew.set(verdict.new, verdict.rotation);
    edges.set(verdict.old, byNew);
  }

  const chain: Rotation[] = [];
  const seen = new Set<string>([key]);
  let current = key;
  let stoppedBecause: SuccessorStop = 'end';

  for (;;) {
    const next = edges.get(current);
    if (next === undefined || next.size === 0) break;
    if (next.size > 1) {
      stoppedBecause = 'fork';
      break;
    }
    const [successor, rotation] = [...next.entries()][0]!;
    if (seen.has(successor)) {
      stoppedBecause = 'cycle';
      break;
    }
    if (chain.length >= MAX_ROTATION_DEPTH) {
      stoppedBecause = 'depth';
      break;
    }
    chain.push(rotation);
    seen.add(successor);
    current = successor;
  }

  return { key, current, chain, rejected, stoppedBecause };
}

/** Is `candidate` the key that now holds `key`'s open edges? */
export function isSuccessorOf(
  candidate: string,
  key: string,
  rotations: readonly unknown[],
  options: VerifyRotationOptions = {},
): boolean {
  if (candidate === key) return true;
  return resolveSuccessor(key, rotations, options).current === candidate;
}
