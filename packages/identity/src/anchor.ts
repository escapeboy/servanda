import { DomainAnchor, PROTOCOL_VERSION } from '@servanda/types';

/**
 * §1.5 — domain anchor.
 *
 * "An org root MAY be anchored to a DNS domain by publishing
 * `https://{domain}/.well-known/servanda.json` and/or a DNS TXT record `_servanda.{domain}`
 * = `v=servanda0.1; k=<pubkey_hex>`. Verifiers MUST check the anchor at signature-verification
 * time and SHOULD cache with the resource's TTL."
 *
 * This package performs NO I/O. Both the HTTP fetch and the DNS lookup are injected, which is
 * what lets the whole identity layer be tested — and shipped — with the network primitives
 * trapped (see test/support/prove-no-network.mjs). With no transport injected, resolution
 * fails closed with `no-transport`; it never falls back to a global fetch.
 */

export type AnchorSource = 'well-known' | 'dns';

export interface AnchorHttpResponse {
  readonly status: number;
  readonly body: string;
  /** Seconds the resource says it may be cached for. Null/absent → do not cache. */
  readonly ttlSeconds?: number | null;
}

export interface AnchorTxtRecord {
  readonly value: string;
  /** The record's DNS TTL in seconds. Null/absent → do not cache. */
  readonly ttlSeconds?: number | null;
}

export interface AnchorTransport {
  /** Resolve `https://{domain}/.well-known/servanda.json`. Return null when unreachable. */
  readonly fetchWellKnown?: (url: string) => Promise<AnchorHttpResponse | null>;
  /** Resolve TXT for `_servanda.{domain}`. Return null when unreachable. */
  readonly resolveTxt?: (name: string) => Promise<readonly AnchorTxtRecord[] | null>;
}

export interface Clock {
  readonly now: () => Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type AnchorFailure =
  /** No resolver was injected. The default: an unconfigured verifier claims nothing. */
  | 'no-transport'
  /** The domain is not a syntactically valid hostname. Refused before any URL is built. */
  | 'invalid-domain'
  /** Every configured source failed to answer. */
  | 'unreachable'
  /** Sources answered, but none carried an anchor. */
  | 'absent'
  /** An anchor document was served but is not a valid §1.5 anchor. */
  | 'malformed'
  /** `.well-known` and DNS disagree about `org_root`. Refused rather than picking a winner. */
  | 'conflict';

export interface AnchorResolution {
  readonly domain: string;
  readonly ok: boolean;
  readonly anchor: DomainAnchor | null;
  readonly sources: readonly AnchorSource[];
  readonly reason: AnchorFailure | null;
  /** Epoch ms this resolution stops being usable. Null → not cacheable, re-resolve every time. */
  readonly expiresAt: number | null;
  readonly checkedAt: string;
}

/** §1.5 TXT payload: `v=servanda0.1; k=<pubkey_hex>`. */
export const ANCHOR_TXT_VERSION = 'servanda0.1';
const TXT_PREFIX = '_servanda.';
const HEX64 = /^[0-9a-f]{64}$/;
/** LDH hostname, at least two labels, ≤253 chars. Refuses schemes, paths, ports, userinfo. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isAnchorableDomain(domain: string): boolean {
  return HOSTNAME.test(domain);
}

export function wellKnownUrl(domain: string): string {
  if (!isAnchorableDomain(domain)) throw new TypeError(`not an anchorable domain: ${domain}`);
  return `https://${domain}/.well-known/servanda.json`;
}

export function txtName(domain: string): string {
  if (!isAnchorableDomain(domain)) throw new TypeError(`not an anchorable domain: ${domain}`);
  return `${TXT_PREFIX}${domain}`;
}

/**
 * Parse a §1.5 TXT payload. Returns null on anything that is not exactly the stated shape —
 * an unknown version token, a missing key, or a key that is not 64 lowercase hex characters.
 */
export function parseAnchorTxt(value: string): DomainAnchor | null {
  const fields = new Map<string, string>();
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return null;
    const name = trimmed.slice(0, eq).trim();
    if (fields.has(name)) return null; // a repeated field has no defined meaning; refuse.
    fields.set(name, trimmed.slice(eq + 1).trim());
  }
  if (fields.get('v') !== ANCHOR_TXT_VERSION) return null;
  const k = fields.get('k');
  if (k === undefined || !HEX64.test(k)) return null;
  // The TXT form carries no hubs. §1.5's JSON `hubs` defaults to empty, so the two forms are
  // comparable on the only field they both carry: org_root.
  return { v: PROTOCOL_VERSION, org_root: k, hubs: [] };
}

/**
 * The longest a DNS answer may pin a cached anchor.
 *
 * The TTL comes from the zone being resolved, so whoever controls that zone chooses how long this
 * process keeps their answer. Without a ceiling, a TTL of a decade pins a poisoned anchor for the
 * lifetime of the process and no later, honest answer is ever consulted — the cache stops being a
 * cache and becomes a decision. A day is long enough that the cache still does its job and short
 * enough that a correction lands the same day.
 */
export const MAX_ANCHOR_TTL_SECONDS = 86_400;

function ttlToExpiry(now: number, ttlSeconds: number | null | undefined): number | null {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return null;
  }
  return now + Math.min(Math.floor(ttlSeconds), MAX_ANCHOR_TTL_SECONDS) * 1000;
}

interface CacheEntry {
  readonly resolution: AnchorResolution;
  readonly expiresAt: number;
}

export interface DomainAnchorResolverOptions {
  readonly transport?: AnchorTransport;
  readonly clock?: Clock;
}

/**
 * Resolves and caches §1.5 anchors. The cache honours the resource's own TTL and reads the
 * time from the injected clock, so cache expiry is a tested property rather than a wall-clock
 * accident. Failures are never cached: a verifier that could not reach the anchor this time
 * must try again next time rather than remember a "no".
 */
export class DomainAnchorResolver {
  readonly #transport: AnchorTransport;
  readonly #clock: Clock;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: DomainAnchorResolverOptions = {}) {
    this.#transport = options.transport ?? {};
    this.#clock = options.clock ?? systemClock;
  }

  get cacheSize(): number {
    return this.#cache.size;
  }

  clearCache(): void {
    this.#cache.clear();
  }

  async resolve(domain: string): Promise<AnchorResolution> {
    const nowMs = this.#clock.now().getTime();
    const cached = this.#cache.get(domain);
    if (cached !== undefined) {
      if (cached.expiresAt > nowMs) return cached.resolution;
      this.#cache.delete(domain);
    }

    const resolution = await this.#resolveUncached(domain, nowMs);
    if (resolution.ok && resolution.expiresAt !== null) {
      this.#cache.set(domain, { resolution, expiresAt: resolution.expiresAt });
    }
    return resolution;
  }

  async #resolveUncached(domain: string, nowMs: number): Promise<AnchorResolution> {
    const checkedAt = new Date(nowMs).toISOString();
    const fail = (reason: AnchorFailure, sources: AnchorSource[] = []): AnchorResolution => ({
      domain,
      ok: false,
      anchor: null,
      sources,
      reason,
      expiresAt: null,
      checkedAt,
    });

    if (!isAnchorableDomain(domain)) return fail('invalid-domain');
    const { fetchWellKnown, resolveTxt } = this.#transport;
    if (fetchWellKnown === undefined && resolveTxt === undefined) return fail('no-transport');

    let reachedAny = false;
    let malformed = false;
    const found: { source: AnchorSource; anchor: DomainAnchor; expiresAt: number | null }[] = [];

    if (fetchWellKnown !== undefined) {
      let res: AnchorHttpResponse | null = null;
      try {
        res = await fetchWellKnown(wellKnownUrl(domain));
      } catch {
        res = null; // an unreachable anchor is an expected condition, not an exception.
      }
      if (res !== null) {
        reachedAny = true;
        if (res.status === 200) {
          const anchor = parseWellKnown(res.body);
          if (anchor === null) malformed = true;
          else {
            found.push({
              source: 'well-known',
              anchor,
              expiresAt: ttlToExpiry(nowMs, res.ttlSeconds),
            });
          }
        }
      }
    }

    if (resolveTxt !== undefined) {
      let records: readonly AnchorTxtRecord[] | null = null;
      try {
        records = await resolveTxt(txtName(domain));
      } catch {
        records = null;
      }
      if (records !== null) {
        reachedAny = true;
        for (const record of records) {
          const anchor = parseAnchorTxt(record.value);
          if (anchor === null) {
            // A `_servanda.` TXT that is not an anchor is noise, not a malformed anchor.
            continue;
          }
          found.push({ source: 'dns', anchor, expiresAt: ttlToExpiry(nowMs, record.ttlSeconds) });
        }
      }
    }

    if (found.length === 0) {
      if (malformed) return fail('malformed', reachedAny ? ['well-known'] : []);
      return fail(reachedAny ? 'absent' : 'unreachable');
    }

    const roots = new Set(found.map((f) => f.anchor.org_root));
    if (roots.size > 1) {
      // §1.5 says "and/or" but never says which wins when they disagree. A disagreement is a
      // failed anchor: an org that cannot state one root has not anchored anything.
      return fail(
        'conflict',
        [...new Set(found.map((f) => f.source))].sort(),
      );
    }

    // The shortest TTL any contributing source stated governs; one source with no stated TTL
    // makes the whole resolution uncacheable.
    const expiries = found.map((f) => f.expiresAt);
    const expiresAt = expiries.includes(null)
      ? null
      : Math.min(...(expiries as number[]));

    // Prefer the well-known document as the carrier, because it is the only form with `hubs`.
    const primary = found.find((f) => f.source === 'well-known') ?? found[0]!;
    return {
      domain,
      ok: true,
      anchor: primary.anchor,
      sources: [...new Set(found.map((f) => f.source))].sort(),
      reason: null,
      expiresAt,
      checkedAt,
    };
  }
}

function parseWellKnown(body: string): DomainAnchor | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = DomainAnchor.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Does this resolution anchor exactly this org root? Used by the ladder for level 3, where an
 * anchor for *some* org proves nothing about *this* org's attestation.
 */
export function anchorsOrgRoot(resolution: AnchorResolution | null | undefined, orgRoot: string): boolean {
  return resolution?.ok === true && resolution.anchor?.org_root === orgRoot;
}
