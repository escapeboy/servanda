import { describe, expect, it } from 'vitest';
import {
  COPY,
  WORDS_WITHHELD,
  buildProof,
  makeProofFixture,
  proofDocument,
  proofEl,
  renderToHtml,
  visibleText,
} from '../../src/index.js';

/**
 * M-15 — "Retention decay: plaintext SHOULD be deleted, edge+assertion chains MUST be
 * preserved."
 *
 * The proof page is what that MUST is *for*. §5.4 and ADR-0004 say a node forgets the words
 * and keeps the signed chain; this surface is the reason anyone should care, because it
 * means a studio can still prove to a client that a promise was made and kept on those
 * dates years after nobody — including the two parties — can reconstruct its terms.
 *
 * So the test that matters is the one below: the certificate rendered with no plaintext
 * available is COMPLETE, not degraded. If any part of this page needed the words, retention
 * decay would quietly destroy the evidence the protocol claims to preserve.
 *
 * SCOPE (stated rather than implied): the other half of M-15 — personal scopes MUST NOT
 * support escrow, team-scope escrow MUST be protocol-visible — is a node-side rule with no
 * surface in this layer. It is not tested here and is not claimed to be.
 */

const THE_WORDS = 'Migrate Acme to the new billing provider by 30 September';

describe('M-15: the proof page is complete with the words gone, and silent without both consents', () => {
  it('renders in full from hashes, keys and dates alone', () => {
    const view = buildProof(makeProofFixture({ plaintext: null }));
    const html = renderToHtml(proofEl(view));

    // Everything a certificate is for is present.
    expect(view.words).toBeNull();
    expect(html).toContain('3'.repeat(64)); // the fingerprint, whole
    expect(html).toContain('a'.repeat(64)); // both parties' keys, whole
    expect(html).toContain('b'.repeat(64));
    expect(view.dates.map((d) => d.label)).toEqual([
      COPY.proof.promised,
      COPY.proof.agreed,
      COPY.proof.due,
      COPY.proof.settled,
    ]);
    expect(view.chain).toHaveLength(4);
    expect(view.chain.map((s) => s.label)).toEqual([
      COPY.chain.proposed,
      COPY.chain.confirmed,
      COPY.chain.disputed,
      COPY.chain.closed,
    ]);
    expect(view.outcome).toBe(COPY.proof.outcomeKept);
    // And it says why the words are absent, rather than looking broken.
    expect(view.wordsNote).toBe(COPY.proof.wordsGone);
  });

  it('is not a smaller page than the one with the words: only the words differ', () => {
    const gone = buildProof(makeProofFixture({ plaintext: null }));
    const kept = buildProof(
      makeProofFixture({
        plaintext: THE_WORDS,
        disclosure: { byOwner: true, byOwedTo: true },
      }),
    );
    const strip = (v: typeof gone) => ({ ...v, words: null, wordsNote: '' });
    expect(strip(gone)).toEqual(strip(kept));
    expect(kept.words).toBe(THE_WORDS);
  });

  it('stands up as a whole shareable document with no words in it', () => {
    const doc = proofDocument(buildProof(makeProofFixture({ plaintext: null })));
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain(COPY.proof.heading);
    expect(doc).toContain('3'.repeat(64));
    expect(doc).not.toContain(THE_WORDS);
    // Self-contained: a certificate that fetched something would stop working when it 404s.
    expect(doc).not.toContain('http');
    expect(doc).not.toContain('src=');
  });

  it('shows nothing when the words are gone, however both parties feel about it', () => {
    const view = buildProof(
      makeProofFixture({ plaintext: null, disclosure: { byOwner: true, byOwedTo: true } }),
    );
    expect(view.words).toBeNull();
    expect(view.wordsNote).toBe(COPY.proof.wordsGone);
    // And it stops asking a question that no longer has an answer.
    expect(
      buildProof(makeProofFixture({ plaintext: null, viewer: 'owner' })).actions,
    ).toEqual([]);
  });
});

/**
 * The second half of the proof page's law: "never plaintext unless both parties opt in."
 * Modelled as two consents combined with `&&`, defaulting to off, so there is no argument
 * by which one party discloses on the other's behalf.
 */
describe('M-15: the words appear only when both parties agreed, and never by default', () => {
  it('withholds the words when nobody said anything', () => {
    const view = buildProof(makeProofFixture({ plaintext: THE_WORDS }));
    expect(view.words).toBeNull();
    expect(view.wordsNote).toBe(COPY.proof.wordsWithheld);
    expect(visibleText(proofEl(view)).join('\n')).not.toContain(THE_WORDS);
  });

  it('withholds the words when exactly one party agreed', () => {
    for (const disclosure of [
      { byOwner: true, byOwedTo: false },
      { byOwner: false, byOwedTo: true },
    ]) {
      const view = buildProof(makeProofFixture({ plaintext: THE_WORDS, disclosure }));
      expect(view.words).toBeNull();
      expect(renderToHtml(proofEl(view))).not.toContain(THE_WORDS);
    }
  });

  it('shows the words only when both agreed', () => {
    const view = buildProof(
      makeProofFixture({ plaintext: THE_WORDS, disclosure: { byOwner: true, byOwedTo: true } }),
    );
    expect(view.words).toBe(THE_WORDS);
    expect(view.wordsNote).toBe(COPY.proof.wordsShown);
    expect(renderToHtml(proofEl(view))).toContain(THE_WORDS);
  });

  it('defaults to withheld when the record says nothing about consent', () => {
    expect(WORDS_WITHHELD).toEqual({ byOwner: false, byOwedTo: false });
    const record = makeProofFixture({ plaintext: THE_WORDS });
    expect(record.disclosure).toBeUndefined();
    expect(buildProof(record).words).toBeNull();
  });

  it('offers the consent to a party who has not given it, and to nobody else', () => {
    const words = { plaintext: THE_WORDS } as const;
    const stranger = buildProof(makeProofFixture({ ...words, viewer: 'public' }));
    expect(stranger.actions).toEqual([]);

    const owner = buildProof(makeProofFixture({ ...words, viewer: 'owner' }));
    expect(owner.actions).toHaveLength(1);
    expect(owner.actions[0]?.label).toBe(COPY.proof.disclose);
    expect(owner.actions[0]?.dispatch).toEqual({
      kind: 'consent',
      consent: 'show-words',
      by: 'owner',
    });

    // Having agreed, they are not asked again — and are told what is still missing.
    const agreed = buildProof(
      makeProofFixture({ ...words, viewer: 'owner', disclosure: { byOwner: true, byOwedTo: false } }),
    );
    expect(agreed.actions).toEqual([]);
    expect(agreed.wordsNote).toBe(COPY.proof.discloseWaiting);
    expect(agreed.words).toBeNull();
  });

  it('has no consent that speaks for the other party', () => {
    const owner = buildProof(makeProofFixture({ plaintext: THE_WORDS, viewer: 'owner' }));
    for (const action of owner.actions) {
      expect(action.dispatch).toMatchObject({ by: 'owner' });
    }
    const other = buildProof(makeProofFixture({ plaintext: THE_WORDS, viewer: 'owed-to' }));
    for (const action of other.actions) {
      expect(action.dispatch).toMatchObject({ by: 'owed-to' });
    }
  });
});
