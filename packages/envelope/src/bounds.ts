import { canonicalBytes } from '@servanda/crypto';

/**
 * §2 bounds / M-19 — an envelope is bounded where it is created.
 *
 * The rule has two halves and they are easy to confuse. The bounds themselves are unremarkable
 * ceilings; what M-19 actually forbids is *silence*. An observation that exceeded a bound must
 * come out clipped and SAID SO, because "this was cut" is the one fact that cannot be recovered
 * from the stored envelope later. Truncating quietly and dropping quietly are the two failures,
 * and they look identical downstream: a short body.
 *
 * Why the bounds are normative rather than local policy: the §2 `id` is a hash of the canonical
 * form, so whatever may appear in that form defines the identifier. Two nodes observing the same
 * source event have to compute the same `id`, which they can only do if the shape is pinned.
 *
 * Everything here counts OCTETS of UTF-8, never JavaScript string length. Those differ for every
 * character outside ASCII, and the spec's numbers are octets.
 */

/** §2: the canonical form of a whole envelope. */
export const MAX_ENVELOPE_OCTETS = 65536;
/** §2: every string member of `payload`. */
export const MAX_PAYLOAD_TEXT = 8192;
/** §2: how deep `payload` may nest below itself. Its own members are level 1. */
export const MAX_PAYLOAD_DEPTH = 8;
/** §2: entries in `refs`. */
export const MAX_REFS = 32;
/** §2: one `refs` entry's `value`. */
export const MAX_REF = 2048;
/** §2: `actor.label`. */
export const MAX_LABEL = 200;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Length in octets of UTF-8, which is what every §2 bound is stated in. */
export function octets(s: string): number {
  return ENCODER.encode(s).length;
}

/**
 * Clip to at most `maxOctets`, cutting on a Unicode scalar boundary.
 *
 * §2: "a clipped value MUST NOT contain a code point absent from the source." Cutting by
 * JavaScript string index breaks that on any multi-byte text — slicing between the two halves of
 * a surrogate pair yields a lone surrogate, which is a code point the source did not contain.
 * Walking back over UTF-8 continuation bytes (10xxxxxx) drops the whole partial scalar instead.
 *
 * The encode/decode round trip only happens when the value is actually over the bound, so a
 * conforming string is returned by identity.
 */
export function clip(s: string, maxOctets: number): string {
  const bytes = ENCODER.encode(s);
  if (bytes.length <= maxOctets) return s;
  let end = maxOctets;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return DECODER.decode(bytes.subarray(0, end));
}

/**
 * A bounds check, stated as the reason it failed rather than as a boolean.
 *
 * This is the node half of M-19: a node MUST reject an envelope that exceeds a bound rather than
 * canonicalize it. `null` means every bound holds.
 */
export function boundsViolation(envelope: unknown): string | null {
  if (typeof envelope !== 'object' || envelope === null) return 'not an object';
  const e = envelope as Record<string, unknown>;

  const actor = e['actor'] as { label?: unknown } | undefined;
  if (typeof actor?.label === 'string' && octets(actor.label) > MAX_LABEL) {
    return `actor.label exceeds ${MAX_LABEL} octets`;
  }

  const refs = e['refs'];
  if (Array.isArray(refs)) {
    if (refs.length > MAX_REFS) return `refs holds more than ${MAX_REFS} entries`;
    for (const ref of refs) {
      const value = (ref as { value?: unknown } | null)?.value;
      if (typeof value === 'string' && octets(value) > MAX_REF) {
        return `a refs value exceeds ${MAX_REF} octets`;
      }
    }
  }

  // `payload` itself is level 0; its own members are the first level below it.
  const deep = payloadViolation(e['payload'], 0);
  if (deep !== null) return deep;

  // The size test has to canonicalize in order to measure, which reads like the very thing M-19
  // forbids. It is not: what the rule forbids is treating that canonical form as the envelope's
  // identity — hashing it, storing it, answering with it. Measuring and discarding is how the
  // rejection is decided at all. The cheap structural checks run first so a hostile document is
  // refused before it is ever serialized, and JCS's own 256-level guard catches what gets past.
  const size = canonicalBytes(e).length;
  if (size > MAX_ENVELOPE_OCTETS) return `canonical form is ${size} octets, over ${MAX_ENVELOPE_OCTETS}`;

  return null;
}

function payloadViolation(value: unknown, depth: number): string | null {
  if (depth > MAX_PAYLOAD_DEPTH) return `payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels`;
  if (typeof value === 'string') {
    return octets(value) > MAX_PAYLOAD_TEXT ? `a payload string exceeds ${MAX_PAYLOAD_TEXT} octets` : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const v = payloadViolation(item, depth + 1);
      if (v !== null) return v;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    for (const member of Object.values(value)) {
      const v = payloadViolation(member, depth + 1);
      if (v !== null) return v;
    }
  }
  return null;
}

/** What `bound` did, so the caller can mark the envelope without guessing. */
interface Bounded {
  value: unknown;
  clipped: boolean;
}

/**
 * Bound one payload value: clip its strings, prune what nests too deep.
 *
 * A clipped string gets a `<key>_length` sibling holding its octet length as this boundary
 * received it — §2's SHOULD — and that write is authoritative. A connector may know a truer
 * number about an earlier stage of its own pipeline (the email parser counts a body before it
 * cuts it), but that is a different question and belongs under a different key: `x_length` is
 * defined by §2 as the length of the value that was clipped, in octets.
 */
function boundPayload(value: unknown, budget: number, depth: number): Bounded {
  if (typeof value === 'string') {
    const out = clip(value, budget);
    return { value: out, clipped: out !== value };
  }
  // A container that sits at the depth limit keeps no children: the branch is dropped, not
  // replaced by an empty one at a level §2 forbids. Emptying in place would leave the envelope
  // still out of bounds, which is how the first version of this passed its own clipping and
  // failed its own bounds check.
  const atLimit = depth >= MAX_PAYLOAD_DEPTH;

  if (Array.isArray(value)) {
    if (atLimit) return { value: [], clipped: value.length > 0 };
    let clipped = false;
    const out = value.map((item) => {
      const b = boundPayload(item, budget, depth + 1);
      clipped ||= b.clipped;
      return b.value;
    });
    return { value: out, clipped };
  }
  if (typeof value === 'object' && value !== null) {
    if (atLimit) return { value: {}, clipped: Object.keys(value).length > 0 };
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let clipped = false;
    for (const key of Object.keys(source)) {
      const b = boundPayload(source[key], budget, depth + 1);
      out[key] = b.value;
      if (b.clipped) {
        clipped = true;
        if (typeof source[key] === 'string') out[`${key}_length`] = octets(source[key]);
      }
    }
    return { value: out, clipped };
  }
  return { value, clipped: false };
}

function tooBig(envelope: Record<string, unknown>): boolean {
  return canonicalBytes(envelope).length > MAX_ENVELOPE_OCTETS;
}

/**
 * Bring an envelope-shaped candidate inside every §2 bound, marking it if anything was cut.
 *
 * `clipped` is `true` or absent — never `false`. §2 says so, and it matters for the `id`: a
 * `"clipped": false` member would be part of the canonical form, so two nodes observing the same
 * event would have to agree on writing it in order to agree on the identifier. Absence is the
 * cheaper agreement.
 *
 * Order matters. Member bounds first, because they are what §2 names; only if the whole canonical
 * form is still over budget does the string allowance shrink, and only if THAT is exhausted are
 * whole payload members dropped. Halving rather than fitting exactly keeps the reduction
 * deterministic — the same input gives the same envelope, and therefore the same `id`, on any
 * machine.
 */
export function bound(candidate: Record<string, unknown>): Record<string, unknown> {
  const out = { ...candidate };
  let clipped = false;

  const actor = out['actor'];
  if (typeof actor === 'object' && actor !== null) {
    const a = actor as Record<string, unknown>;
    if (typeof a['label'] === 'string') {
      const label = clip(a['label'], MAX_LABEL);
      if (label !== a['label']) {
        out['actor'] = { ...a, label };
        clipped = true;
      }
    }
  }

  const refs = out['refs'];
  if (Array.isArray(refs)) {
    const kept = refs.slice(0, MAX_REFS);
    if (kept.length !== refs.length) clipped = true;
    out['refs'] = kept.map((ref) => {
      if (typeof ref !== 'object' || ref === null) return ref;
      const r = ref as Record<string, unknown>;
      if (typeof r['value'] !== 'string') return r;
      const value = clip(r['value'], MAX_REF);
      if (value === r['value']) return r;
      clipped = true;
      return { ...r, value };
    });
  }

  const payload = candidate['payload'];
  let budget = MAX_PAYLOAD_TEXT;
  const apply = (b: number): void => {
    const bounded = boundPayload(payload, b, 0);
    out['payload'] = bounded.value;
    if (bounded.clipped) clipped = true;
  };
  apply(budget);

  // The payload fits member by member and the envelope as a whole still does not: tighten the
  // string allowance until it does. 64 octets is where a string stops carrying an observation
  // and starts being a stub, so below that the reduction moves on to dropping members.
  while (tooBig(out) && budget > 64) {
    budget = Math.floor(budget / 2);
    apply(budget);
    clipped = true;
  }

  // Nothing left to shrink: the payload has more members than the bound can hold whatever they
  // say. Drop from the end of canonical key order, taking each member's `_length` sibling with
  // it, until the envelope fits. The observation itself — source, kind, actor, timestamps —
  // survives, which is the part §2 says must not be discarded.
  if (tooBig(out)) {
    const reduced = { ...(out['payload'] as Record<string, unknown>) };
    for (const key of Object.keys(reduced).sort().reverse()) {
      if (!tooBig({ ...out, payload: reduced })) break;
      delete reduced[key];
      delete reduced[`${key}_length`];
      clipped = true;
    }
    out['payload'] = reduced;
  }

  // Thirty-two refs of 2048 octets each reach the envelope bound on their own, so an empty
  // payload is not always enough. Refs go last because a ref is a pointer back to the source:
  // whatever survives here is what makes the observation followable.
  while (tooBig(out) && Array.isArray(out['refs']) && out['refs'].length > 0) {
    out['refs'] = out['refs'].slice(0, -1);
    clipped = true;
  }

  if (clipped) out['clipped'] = true;
  else delete out['clipped'];
  return out;
}
