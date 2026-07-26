import { describe, expect, it } from 'vitest';
import {
  COPY,
  RELIEF_BY_LEVEL,
  buildProof,
  makeProofFixture,
  proofDocument,
  proofEl,
  renderToHtml,
  visibleText,
  walk,
} from '../src/index.js';

/**
 * The proof page as an interface object — doctrine surface 7.
 *
 * What is checked here is that the page is *readable by a stranger*: it names the two
 * parties with the evidence behind each name, gives the dates, gives the chain in order,
 * and shows the fingerprint whole. Its two laws — renders without plaintext, never shows
 * the words without both consents — are in the named M-15 test, not here.
 */
describe('a closed promise generates a certificate anyone with the link can read', () => {
  const view = buildProof(makeProofFixture());

  it('names both parties, each with the evidence behind the name (M-12)', () => {
    expect(view.parties.map((p) => p.role)).toEqual([COPY.proof.roleOwner, COPY.proof.roleOwedTo]);
    expect(view.parties.map((p) => p.party.display)).toEqual([
      'Studio (studio.bg)',
      'Acme (acme.com)',
    ]);
    for (const p of view.parties) {
      expect(p.party.trust.relief).toBe(RELIEF_BY_LEVEL[p.party.trust.level]);
      expect(p.party.trust.label).toBe(COPY.trust[p.party.trust.level]);
    }
  });

  it('falls back to the key when a party has no name, and does not dress it up', () => {
    const anonymous = buildProof(
      makeProofFixture({
        owner: { key: 'a'.repeat(64), display: null, verification_level: '0' },
      }),
    );
    const owner = anonymous.parties[0];
    expect(owner?.party.isKey).toBe(true);
    expect(owner?.party.display).not.toBe('a'.repeat(64));
    // The whole key is still on the page, in mono, for anyone who wants to check it.
    expect(renderToHtml(proofEl(anonymous))).toContain('a'.repeat(64));
  });

  it('gives the chain in the order it happened, each step with its mark and its signer', () => {
    expect(view.chain.map((s) => s.when)).toEqual([
      '2026-06-02T10:15:00Z',
      '2026-06-02T16:40:00Z',
      '2026-10-01T09:00:00Z',
      '2026-10-06T11:20:00Z',
    ]);
    expect(view.chain.map((s) => s.seal.shape)).toEqual(['half', 'joined', 'cracked', 'marked']);
    for (const step of view.chain) expect(step.signedBy).toMatch(/^Signed by /u);
    // A dispute is part of the record, not a blemish hidden from the certificate.
    expect(view.chain[2]?.label).toBe(COPY.chain.disputed);
    expect(view.chain[2]?.evidence).not.toBeNull();
  });

  it('reads the outcome off the last thing that happened', () => {
    const outcomes: [string, string][] = [
      ['closed', COPY.proof.outcomeKept],
      ['released', COPY.proof.outcomeReleased],
      ['disputed', COPY.proof.outcomeDisputed],
      ['superseded', COPY.proof.outcomeReplaced],
    ];
    for (const [state, expected] of outcomes) {
      const one = buildProof(
        makeProofFixture({
          chain: [{ state, asserted_at: '2026-10-06T11:20:00Z', by: 'a'.repeat(64), evidence_hash: null }],
        }),
      );
      expect(one.outcome).toBe(expected);
    }
    expect(buildProof(makeProofFixture({ chain: [] })).outcome).toBe(COPY.proof.outcomeOpen);
  });

  it('renders with no chain at all rather than throwing', () => {
    const empty = buildProof(makeProofFixture({ chain: [], due: null }));
    expect(empty.chain).toEqual([]);
    expect(empty.dates.map((d) => d.label)).toEqual([COPY.proof.promised]);
    expect(renderToHtml(proofEl(empty)).length).toBeGreaterThan(0);
  });

  it('shows the fingerprint whole and explains what it is for', () => {
    expect(view.fingerprint).toBe('3'.repeat(64));
    expect(view.fingerprintNote).toBe(COPY.proof.fingerprintNote);
    expect(visibleText(proofEl(view))).toContain('3'.repeat(64));
  });

  it('sets every hash and key in mono, and no name in it', () => {
    for (const node of walk(proofEl(view))) {
      const classes = String(node.attrs?.['class'] ?? '');
      if (!classes.includes('hash')) continue;
      expect((node.text ?? '').length).toBeGreaterThan(0);
    }
    const html = renderToHtml(proofEl(view));
    expect(html).toContain('class="hash fingerprint"');
  });

  it('is a page a stranger can read: a heading, an explanation, and no jargon', () => {
    expect(view.heading).toBe(COPY.proof.heading);
    expect(view.lede).toBe(COPY.proof.lede);
    const doc = proofDocument(view);
    expect(doc).toContain('<title>');
    expect(doc).toContain('viewport');
  });
});
