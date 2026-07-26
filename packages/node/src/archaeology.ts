import type { Commitment, Envelope } from '@servanda/types';

/**
 * Archaeology ingest — §2 archaeology envelopes → §3.1 commitments with `source: "archaeology"`.
 *
 * §3.1 names `archaeology` as a commitment source distinct from `extracted`, and it earns that
 * distinction here: this mapping is **deterministic and model-free**. A TODO that has sat in the
 * tree for 1295 days is not an inference about what somebody meant — it is a fact about the
 * repository. Running it through a language model would add latency, cost and injection surface
 * to a lookup that needs none of them.
 *
 * M-6 governs the text: `payload.text` is attacker-authored (anyone can write a TODO). It is
 * carried into `intent` as DATA — quoted, length-bounded, and never parsed for meaning. No field
 * of an envelope reaches a decision in this function; only `kind` selects a branch, and `kind` is
 * set by the connector, not by the repository's contents.
 */

/** §3.1 caps `intent` at 500 characters; leave room for the surrounding phrasing. */
const MAX_QUOTED_TEXT = 300;

function quote(text: unknown): string {
  const s = typeof text === 'string' ? text : '';
  // Collapse whitespace so a multi-line comment cannot reshape a brief line.
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_QUOTED_TEXT ? `${flat.slice(0, MAX_QUOTED_TEXT)}…` : flat;
}

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v : '';
}

function num(payload: Record<string, unknown>, key: string): number {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export interface ArchaeologyCandidate {
  commitment: Commitment;
  envelopeId: string;
  /** Sort key for "the five oldest findings" — days since the finding's anchoring commit. */
  ageDays: number;
}

/**
 * Confidence is a claim about whether this finding is a promise the owner actually holds — not
 * about whether the finding is real. A never-applied migration is a strong signal that something
 * is owed; a TODO someone wrote in passing is weaker. These are deliberately middling: the brief
 * exists so a human can dismiss the wrong ones cheaply.
 */
const CONFIDENCE: Record<string, number> = {
  archaeology_unrun_migration: 0.7,
  archaeology_dead_flag: 0.6,
  archaeology_todo: 0.5,
  archaeology_stale_branch: 0.4,
};

function intentFor(kind: string, payload: Record<string, unknown>): string | null {
  switch (kind) {
    case 'archaeology_todo': {
      const where = `${str(payload, 'file')}:${num(payload, 'line')}`;
      const marker = str(payload, 'marker') || 'TODO';
      return `Resolve ${marker} in ${where}: "${quote(payload['text'])}"`;
    }
    case 'archaeology_stale_branch':
      return `Decide the fate of branch ${str(payload, 'branch')}, dormant ${num(payload, 'age_days')} days`;
    case 'archaeology_dead_flag':
      return `Remove the dead path behind flag ${str(payload, 'flag')} in ${str(payload, 'file')}`;
    case 'archaeology_unrun_migration':
      return `Apply or retire migration ${str(payload, 'migration_id')}`;
    default:
      // Not an archaeology finding, or a kind this version does not understand. Emitting nothing
      // is the correct response to an unrecognized signal (§3.4's "or nothing" applies here too).
      return null;
  }
}

/**
 * Map archaeology envelopes to reflexive commitments.
 *
 * `owed_to` is null: these are promises to yourself, so they never leave the vault and never
 * become edges. `due` is null and MUST stay null — §3.1 forbids time-escalating undated
 * commitments, and an old TODO is old, not late.
 */
export function archaeologyCandidates(
  envelopes: readonly Envelope[],
  opts: { persona: string; createdAt: string },
): ArchaeologyCandidate[] {
  const out: ArchaeologyCandidate[] = [];

  for (const envelope of envelopes) {
    if (!envelope.kind.startsWith('archaeology_')) continue;
    const payload = envelope.payload as Record<string, unknown>;
    const intent = intentFor(envelope.kind, payload);
    if (intent === null) continue;

    out.push({
      envelopeId: envelope.id,
      ageDays: num(payload, 'age_days'),
      commitment: {
        v: 'servanda/0.1',
        type: 'commitment',
        intent: intent.slice(0, 500),
        owner: opts.persona,
        owed_to: null,
        due: null,
        conditions: [],
        evidence_refs: [{ kind: 'envelope', value: envelope.id }],
        created_at: opts.createdAt,
        source: 'archaeology',
        confidence: CONFIDENCE[envelope.kind] ?? 0.5,
      },
    });
  }

  // Oldest first — scenario 2's "five oldest findings". Ties break on envelope id so the order is
  // total and reproducible rather than dependent on traversal.
  out.sort((a, b) => b.ageDays - a.ageDays || a.envelopeId.localeCompare(b.envelopeId));
  return out;
}
