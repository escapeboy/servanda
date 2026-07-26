import { derivePersona, mnemonicToSeed, withSignature } from '@servanda/crypto';
import type { Attestation, Revocation } from '@servanda/types';
import { PROTOCOL_VERSION } from '@servanda/types';
import type {
  AnchorHttpResponse,
  AnchorTransport,
  AnchorTxtRecord,
  Clock,
} from '../../src/index.js';

/**
 * Deterministic keys from a published BIP-39 test mnemonic. No clock, no randomness, no
 * network — the same three properties the vector generator holds itself to.
 */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';

const SEED = mnemonicToSeed(MNEMONIC);

export interface Key {
  readonly id: string;
  readonly privateKey: string;
}

function key(index: number): Key {
  const p = derivePersona(SEED, index);
  return { id: p.personaId, privateKey: p.privateKey };
}

/** Cast as: an org, two of its people, an unrelated org, and an attacker. */
export const ORG = key(10);
export const OTHER_ORG = key(11);
export const MARIA = key(12);
export const DANA = key(13);
export const ATTACKER = key(14);
export const GROUP = key(15);
export const FRESH = key(16);

export const T = {
  issued: '2026-01-01T00:00:00Z',
  before: '2026-03-01T00:00:00Z',
  revoked: '2026-06-01T00:00:00Z',
  after: '2026-09-01T00:00:00Z',
  expires: '2027-01-01T00:00:00Z',
  afterExpiry: '2027-02-01T00:00:00Z',
} as const;

export function at(iso: string): Date {
  return new Date(iso);
}

export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

/** A clock the test drives by hand — for cache-expiry assertions. */
export function stepClock(startIso: string): Clock & { advance: (seconds: number) => void } {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    advance: (seconds: number) => {
      ms += seconds * 1000;
    },
  };
}

export function attestation(overrides: {
  org?: Key;
  subject?: string;
  subject_kind?: 'persona' | 'group';
  display_name?: string;
  handle?: string;
  members?: string[];
  issued_at?: string;
  expires_at?: string;
  /** Sign with this key instead of the org — the forgery lever. */
  signWith?: Key;
} = {}): Attestation {
  const org = overrides.org ?? ORG;
  const claims: Record<string, unknown> = {};
  if (overrides.display_name !== undefined) claims.display_name = overrides.display_name;
  if (overrides.handle !== undefined) claims.handle = overrides.handle;
  if (overrides.members !== undefined) claims.members = overrides.members;
  const core = {
    v: PROTOCOL_VERSION,
    type: 'attestation' as const,
    org: org.id,
    subject: overrides.subject ?? MARIA.id,
    subject_kind: overrides.subject_kind ?? ('persona' as const),
    claims: Object.keys(claims).length > 0 ? claims : { display_name: 'Maria Ivanova' },
    issued_at: overrides.issued_at ?? T.issued,
    expires_at: overrides.expires_at ?? T.expires,
  };
  return withSignature(core, (overrides.signWith ?? org).privateKey) as unknown as Attestation;
}

export function revocation(overrides: {
  org?: Key;
  subject?: string;
  revoked_at?: string;
  signWith?: Key;
} = {}): Revocation {
  const org = overrides.org ?? ORG;
  const core = {
    v: PROTOCOL_VERSION,
    type: 'revocation' as const,
    org: org.id,
    subject: overrides.subject ?? MARIA.id,
    revoked_at: overrides.revoked_at ?? T.revoked,
  };
  return withSignature(core, (overrides.signWith ?? org).privateKey) as unknown as Revocation;
}

// ── anchor transports ──────────────────────────────────────────────────────────────────────
//
// Every transport here is a plain function over in-memory data. Nothing in the test tree can
// reach the network even if the trap in prove-no-network.mjs were removed.

export function wellKnownTransport(
  body: string | Record<string, unknown>,
  opts: { status?: number; ttlSeconds?: number | null } = {},
): AnchorTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchWellKnown: async (url: string): Promise<AnchorHttpResponse> => {
      calls.push(url);
      return {
        status: opts.status ?? 200,
        body: typeof body === 'string' ? body : JSON.stringify(body),
        ttlSeconds: opts.ttlSeconds === undefined ? 3600 : opts.ttlSeconds,
      };
    },
  };
}

export function txtTransport(
  values: readonly string[],
  opts: { ttlSeconds?: number | null } = {},
): AnchorTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveTxt: async (name: string): Promise<readonly AnchorTxtRecord[]> => {
      calls.push(name);
      return values.map((value) => ({
        value,
        ttlSeconds: opts.ttlSeconds === undefined ? 300 : opts.ttlSeconds,
      }));
    },
  };
}

export function unreachableTransport(): AnchorTransport {
  return { fetchWellKnown: async () => null, resolveTxt: async () => null };
}

export function anchorDocument(orgRoot = ORG.id, hubs: string[] = []): Record<string, unknown> {
  return { v: PROTOCOL_VERSION, org_root: orgRoot, hubs };
}

export function anchorTxt(orgRoot = ORG.id): string {
  return `v=servanda0.1; k=${orgRoot}`;
}
