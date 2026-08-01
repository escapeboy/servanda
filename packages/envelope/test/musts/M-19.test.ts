import { describe, expect, it } from 'vitest';
import { canonicalBytes } from '@servanda/crypto';
import { Envelope } from '@servanda/types';
import {
  EnvelopeBoundsExceeded,
  MAX_ENVELOPE_OCTETS,
  MAX_LABEL,
  MAX_PAYLOAD_DEPTH,
  MAX_PAYLOAD_TEXT,
  MAX_REF,
  MAX_REFS,
  acceptEnvelope,
  boundsViolation,
  clip,
  octets,
  sealEnvelope,
} from '../../src/index.js';

/**
 * M-19 — envelopes are bounded, and what was cut is SAID.
 *
 * The bounds themselves are the easy half. The half worth testing is the silence: an over-long
 * observation must come back clipped AND marked, because "this was cut" is the only fact that
 * cannot be recovered from the stored envelope afterwards. A short body and a body that was
 * silently truncated to look short are indistinguishable downstream, and §2 forbids both
 * silent truncation and silent dropping in the same sentence.
 *
 * These used to be the whole of the enforcement — §8 recorded that the suite could not reach the
 * rule because no envelope vector family existed. It does now, and `../envelope-vectors.test.ts`
 * replays it: the bounds, the id preimage, and the clipping boundary are checked against numbers
 * written upstream rather than against this package's opinion of itself. What stays here is the
 * behaviour a vector cannot express — that an over-long observation comes back clipped AND
 * marked, and that the marking survives.
 */

const PERSONA = 'a'.repeat(64);

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 'servanda/0.1',
    type: 'envelope',
    source: 'github',
    kind: 'pr_comment',
    occurred_at: '2026-07-31T09:00:00Z',
    received_at: '2026-07-31T09:00:01Z',
    actor: { label: 'someone' },
    payload: { text: 'short enough' },
    refs: [],
    persona: PERSONA,
    ...over,
  };
}

describe('M-19: bounds are octets, cuts are on scalar boundaries', () => {
  it('counts octets, not JavaScript string length', () => {
    // Four octets, two UTF-16 code units, one scalar. Every §2 number is the first of those.
    expect(octets('😀')).toBe(4);
    expect('😀'.length).toBe(2);
  });

  it('never cuts a scalar in half', () => {
    // Cutting by string index here would land between the surrogates and produce a code point
    // the source never contained — §2 names that case specifically.
    const cut = clip('😀'.repeat(10), 10);
    expect(octets(cut)).toBeLessThanOrEqual(10);
    expect(cut).toBe('😀😀');
    expect([...cut].every((c) => c === '😀')).toBe(true);
  });

  it('returns a conforming string unchanged', () => {
    const s = 'подписано';
    expect(clip(s, MAX_PAYLOAD_TEXT)).toBe(s);
  });
});

describe('M-19: a clipped envelope says so', () => {
  it('marks a clipped payload string and records the length as observed', () => {
    const text = 'x'.repeat(MAX_PAYLOAD_TEXT + 1000);
    const sealed = sealEnvelope(envelope({ payload: { text } }));

    expect(octets(sealed.payload['text'] as string)).toBe(MAX_PAYLOAD_TEXT);
    expect(sealed.clipped).toBe(true);
    expect(sealed.payload['text_length']).toBe(MAX_PAYLOAD_TEXT + 1000);
  });

  it('leaves the marker ABSENT, not false, when nothing was cut', () => {
    const sealed = sealEnvelope(envelope());
    expect(sealed.clipped).toBeUndefined();
    // Absence rather than `false` is load-bearing: the member is inside the canonical form the
    // `id` is computed over, so two nodes must not have to agree on writing it in order to agree
    // on the identifier.
    expect(canonicalBytes(sealed).toString()).not.toContain('clipped');
    expect(Object.keys(sealed)).not.toContain('clipped');
  });

  it('marks a clipped actor.label, a clipped ref, and a dropped ref', () => {
    const long = sealEnvelope(envelope({ actor: { label: 'l'.repeat(MAX_LABEL + 1) } }));
    expect(octets(long.actor.label)).toBe(MAX_LABEL);
    expect(long.clipped).toBe(true);

    const ref = sealEnvelope(
      envelope({ refs: [{ kind: 'url', value: `https://x/${'y'.repeat(MAX_REF)}` }] }),
    );
    expect(octets(ref.refs[0]!.value)).toBe(MAX_REF);
    expect(ref.clipped).toBe(true);

    const many = sealEnvelope(
      envelope({
        refs: Array.from({ length: MAX_REFS + 5 }, (_, i) => ({ kind: 'issue', value: `r#${i}` })),
      }),
    );
    expect(many.refs).toHaveLength(MAX_REFS);
    expect(many.clipped).toBe(true);
  });

  it('prunes what nests too deep rather than refusing the observation', () => {
    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let i = 0; i < MAX_PAYLOAD_DEPTH + 4; i++) deep = { down: deep };
    const sealed = sealEnvelope(envelope({ payload: deep }));

    expect(sealed.clipped).toBe(true);
    // The envelope survives — §2's "MUST NOT discard the observation". Only the over-deep branch
    // is gone, and `clipped` is what says so.
    expect(sealed.payload['down']).toBeDefined();
    expect(boundsViolation(sealed)).toBeNull();
  });

  it('brings a payload of many long strings under the whole-envelope bound', () => {
    // Every member is individually inside MAX_PAYLOAD_TEXT and the envelope is still far over
    // 65536 octets. Member-wise bounds alone cannot fix this, which is why the reduction exists.
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) payload[`k${i}`] = 'z'.repeat(MAX_PAYLOAD_TEXT);
    const sealed = sealEnvelope(envelope({ payload }));

    expect(canonicalBytes(sealed).length).toBeLessThanOrEqual(MAX_ENVELOPE_OCTETS);
    expect(sealed.clipped).toBe(true);
    // What must NOT happen is the whole observation vanishing.
    expect(sealed.source).toBe('github');
    expect(Object.keys(sealed.payload).length).toBeGreaterThan(0);
  });

  it('keeps a `clipped` the caller had already set, even when it cuts nothing itself', () => {
    // A connector that truncated upstream — a MIME body cut at the parser, a transcript read to a
    // byte budget — knows something was lost that this boundary cannot see. Clearing the marker
    // because nothing needed cutting HERE republishes the observation as whole, and the envelope
    // that comes out is perfectly well-formed, so nothing downstream can tell. That is the
    // silence M-19 is about, not the truncation.
    const sealed = sealEnvelope(envelope({ clipped: true }));
    expect(sealed.clipped).toBe(true);
  });

  it('is deterministic: the same source gives the same clipped envelope and the same id', () => {
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) payload[`k${i}`] = 'z'.repeat(MAX_PAYLOAD_TEXT);
    const a = sealEnvelope(envelope({ payload }));
    const b = sealEnvelope(envelope({ payload }));
    expect(a.id).toBe(b.id);
    // The reduction halves a budget rather than fitting exactly, so it lands on the same
    // envelope on any machine — the `id` is a hash of the result, so an adaptive reduction
    // would make the identifier implementation-defined, which is the failure §2's bounds exist
    // to prevent.
    expect(canonicalBytes(a)).toEqual(canonicalBytes(b));
  });

  it('every sealed envelope is inside every bound, whatever it was handed', () => {
    for (const payload of [
      { text: 'x'.repeat(200_000) },
      { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 'deep' } } } } } } } } } },
      { list: Array.from({ length: 500 }, () => 'w'.repeat(4096)) },
    ]) {
      expect(boundsViolation(sealEnvelope(envelope({ payload })))).toBeNull();
    }
  });

  it('refuses rather than emitting an envelope it could not bring inside the bounds', () => {
    // The reduction owns `payload` and `refs`. It does not own `kind`, `source`, or
    // `actor.external_id` — §2 states no bound for those and shortening a `kind` would change
    // what the observation claims to be — so an oversized one survives every stage of the
    // reduction and the envelope leaves the seal over the whole-form bound.
    //
    // The failure that mattered was not the size. It was that this used to be returned: an
    // envelope with an `id` computed over a canonical form §2 forbids, stored locally, and
    // refused by `acceptEnvelope` on every node that would ever see it, with nothing saying why.
    // The connector is the only layer that can shorten these, so it is the layer that must hear.
    for (const over of [
      { kind: 'k'.repeat(MAX_ENVELOPE_OCTETS + 1) },
      { actor: { label: 'someone', external_id: 'e'.repeat(MAX_ENVELOPE_OCTETS + 1) } },
    ]) {
      expect(() => sealEnvelope(envelope(over))).toThrow(EnvelopeBoundsExceeded);
    }
  });
});

describe('M-19: a node rejects an out-of-bounds envelope rather than canonicalizing it', () => {
  // The node half. This implementation has no ingress for foreign envelopes — its connectors are
  // libraries called in-process, the §2 `emit_envelope` divergence recorded in the README — so
  // the guard is exercised here directly. A rule whose only statement is prose is a rule nothing
  // can be held to.
  const oversize = () =>
    Envelope.parse({ ...envelope({ payload: { text: 'x'.repeat(MAX_PAYLOAD_TEXT + 1) } }), id: 'b'.repeat(64) });

  it('names the bound it refused on', () => {
    expect(() => acceptEnvelope(oversize())).toThrow(EnvelopeBoundsExceeded);
    expect(boundsViolation(oversize())).toMatch(/payload string exceeds/u);
  });

  it('does not re-clip: re-clipping would change the id the sender computed', () => {
    // Silently bringing a foreign envelope inside the bounds would make this node's `id` for it
    // disagree with its sender's, and would hide that the sender emitted something §2 forbids.
    let accepted: unknown;
    try {
      accepted = acceptEnvelope(oversize());
    } catch {
      accepted = undefined;
    }
    expect(accepted).toBeUndefined();
  });

  it('accepts an envelope that is inside the bounds', () => {
    const sealed = sealEnvelope(envelope());
    expect(acceptEnvelope(sealed).id).toBe(sealed.id);
  });
});
