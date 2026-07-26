import type { RunRejection } from '../extractor.js';
import type { Disposition } from '../routing.js';
import { EXPECTATION_ONLY } from '../routing.js';
import type { ScanResult } from './transcripts.js';

/**
 * The precision report: everything a human needs to judge each extraction, and nothing that
 * pretends to have judged it for them.
 *
 * Precision is a human verdict. This file renders evidence — the commitment, the verbatim span
 * it came from, enough surrounding text to tell whether the span means what the extractor thinks
 * it means, and where to look it up — and leaves a box to tick.
 */

export interface ReportRow {
  readonly ref: string;
  readonly intent: string;
  readonly owner: string;
  readonly owedTo: string;
  readonly due: string | null;
  readonly confidence: number;
  readonly disposition: Disposition;
  readonly objectType: 'commitment' | 'expectation';
  readonly quote: string;
  readonly context: string;
  readonly transcript: string;
  readonly transcriptLine: number;
  readonly occurredAt: string;
  readonly envelopeId: string;
  readonly pendingId: string;
}

export interface ReportInput {
  readonly generatedAt: string;
  readonly mode: 'stub' | 'live';
  readonly modelId: string;
  /**
   * How the live backend reached a model, when there is one. The report must not claim the
   * Anthropic API was used when a different backend produced the rows — the whole value of this
   * document is that a human can trust what it says about its own provenance.
   */
  readonly modeNote?: string;
  readonly persona: string;
  readonly scan: ScanResult['stats'];
  readonly batches: number;
  readonly rejectedBatches: readonly { readonly batch: number; readonly rejection: RunRejection }[];
  readonly rows: readonly ReportRow[];
  readonly liveRunSkippedReason?: string;
}

const FENCE = '~~~~~~';

function fenced(text: string): string {
  const safe = text
    .split('\n')
    .map((line) => (line.startsWith(FENCE) ? ` ${line}` : line))
    .join('\n');
  return `${FENCE}text\n${safe}\n${FENCE}`;
}

function cell(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function shortParty(value: string | null): string {
  if (value === null) return '—';
  return /^[0-9a-f]{64}$/.test(value) ? `${value.slice(0, 12)}… (persona)` : value;
}

const BUCKETS = [
  { name: 'High confidence (≥ 0.80)', min: 0.8, max: 1.01 },
  { name: 'Medium confidence (0.50 – 0.79)', min: 0.5, max: 0.8 },
  { name: 'Low confidence (< 0.50)', min: -0.01, max: 0.5 },
] as const;

function renderGroup(name: string, rows: readonly ReportRow[]): string {
  if (rows.length === 0) return `### ${name}\n\nNone.\n`;
  const lines: string[] = [`### ${name} — ${rows.length}\n`];
  lines.push('| Ref | Correct? | Intent | Owner | Owed to | Due | Conf | Routed as |');
  lines.push('| --- | :---: | --- | --- | --- | --- | ---: | --- |');
  for (const row of rows) {
    lines.push(
      `| ${row.ref} | [ ] | ${cell(row.intent)} | ${cell(shortParty(row.owner), 30)} | ` +
        `${cell(shortParty(row.owedTo === '—' ? null : row.owedTo), 30)} | ${row.due ?? '—'} | ` +
        `${row.confidence.toFixed(2)} | ${row.disposition} |`,
    );
  }
  lines.push('');
  for (const row of rows) {
    lines.push(`<details>`);
    lines.push(`<summary><b>${row.ref}</b> — ${cell(row.intent, 120)}</summary>`);
    lines.push('');
    lines.push(`- **Object:** ${row.objectType} (§${row.objectType === 'commitment' ? '3.1' : '3.3'})`);
    lines.push(`- **Owner:** ${shortParty(row.owner)}`);
    lines.push(`- **Owed to:** ${row.owedTo === '—' ? '— (reflexive)' : shortParty(row.owedTo)}`);
    lines.push(`- **Due:** ${row.due ?? 'null'}`);
    lines.push(`- **Confidence:** ${row.confidence.toFixed(2)}`);
    lines.push(`- **Disposition:** \`${row.disposition}\``);
    lines.push(`- **Transcript:** \`${row.transcript}\` line ${row.transcriptLine}`);
    lines.push(`- **Occurred at:** ${row.occurredAt}`);
    lines.push(`- **Envelope:** \`${row.envelopeId}\``);
    lines.push(`- **Queue item:** \`${row.pendingId}\` (pending confirmation — nothing committed)`);
    lines.push('');
    lines.push('**Verbatim quote**');
    lines.push('');
    lines.push(fenced(row.quote));
    lines.push('');
    lines.push('**Surrounding context**');
    lines.push('');
    lines.push(fenced(row.context));
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  return lines.join('\n');
}

export function renderReport(input: ReportInput): string {
  const { scan, rows } = input;
  const dispositions = new Map<Disposition, number>();
  for (const row of rows) dispositions.set(row.disposition, (dispositions.get(row.disposition) ?? 0) + 1);
  const rate = scan.envelopes === 0 ? 0 : (rows.length / scan.envelopes) * 100;

  const out: string[] = [];
  out.push('# Servanda extraction — precision report');
  out.push('');
  out.push(
    '> **Nothing in this report has been committed to anything.** The harness is read-only with ' +
      'respect to protocol state: it did not write to a vault, a ledger, an edge store, or the ' +
      'wire, and it did not modify a single transcript. Every result below sits in an in-memory ' +
      'pending-confirmation queue that is discarded when the process exits. §9.2: a fooled model ' +
      'can produce at most an unconfirmed proposal — nothing a human didn\'t sign.',
  );
  out.push('');
  out.push(
    '> **The precision verdict is yours.** Tick the `Correct?` box for each row you judge to be a ' +
      'real commitment, correctly attributed. The harness does not score itself.',
  );
  out.push('');
  if (input.mode === 'stub') {
    out.push(
      '> ⚠️ **These findings came from the stub, not from a model.** The stub is a small regex ' +
        'rule table that exists so the pipeline can be run and gated without an API key or spend. ' +
        'It has no judgement: it cannot tell a commitment from a conditional offer, and it quotes ' +
        'whatever clause its pattern landed in. **Whatever fraction of the rows below you judge ' +
        'correct is a fact about the stub, and says nothing about the extractor\'s precision.** ' +
        'Answering "is precision ≥ 90%?" requires a live run — see the *Live run* row above for ' +
        'why one did not happen.',
    );
    out.push('');
  }

  out.push('## Run');
  out.push('');
  out.push('| | |');
  out.push('| --- | --- |');
  out.push(`| Generated | ${input.generatedAt} |`);
  out.push(
    `| Extraction mode | **${input.mode}** ${
      input.mode === 'stub'
        ? '— deterministic rule-based stand-in, no API calls, no spend'
        : (input.modeNote ?? '— live Anthropic API')
    } |`,
  );
  out.push(`| Model | \`${input.modelId}\` |`);
  out.push(`| Persona (synthetic, harness-local) | \`${input.persona.slice(0, 16)}…\` |`);
  out.push(`| Transcript root | \`${scan.root}\` (read-only) |`);
  out.push(`| Window | last ${scan.days} days (since ${scan.since}) |`);
  if (input.liveRunSkippedReason !== undefined) {
    out.push(`| Live run | **not exercised** — ${input.liveRunSkippedReason} |`);
  }
  out.push('');

  out.push('## Totals');
  out.push('');
  out.push('| Metric | Value |');
  out.push('| --- | ---: |');
  out.push(`| Transcripts in window | ${scan.transcriptsFound} |`);
  out.push(`| Transcripts scanned | ${scan.transcriptsScanned} |`);
  out.push(
    `| Subagent transcripts skipped (M-13: an agent is never a party) | ${scan.subagentTranscriptsSkipped} |`,
  );
  out.push(`| Lines read | ${scan.linesRead} |`);
  out.push(`| Lines malformed (skipped) | ${scan.linesMalformed} |`);
  out.push(`| Human utterances found | ${scan.utterances} |`);
  out.push(`| Duplicate utterances skipped (resumed sessions) | ${scan.duplicatesSkipped} |`);
  out.push(`| Envelopes produced | ${scan.envelopes} |`);
  out.push(`| Extraction batches | ${input.batches} |`);
  out.push(`| Batches discarded whole (schema-bound) | ${input.rejectedBatches.length} |`);
  out.push(`| **Commitments + expectations extracted** | **${rows.length}** |`);
  out.push(`| Extraction rate | ${rate.toFixed(2)} per 100 envelopes |`);
  out.push('');
  if (scan.truncated) {
    out.push(
      '> Note: the scan was capped by a `--max-transcripts` / `--max-envelopes` limit, so this is ' +
        'a sample of the window, not the whole of it.',
    );
    out.push('');
  }

  out.push('### Routing (§3.4)');
  out.push('');
  out.push('| Disposition | Count | May become a wire `propose`? |');
  out.push('| --- | ---: | --- |');
  for (const [disposition, count] of [...dispositions.entries()].sort()) {
    const proposable =
      disposition === 'proposable-after-confirmation'
        ? 'only after an explicit local-user confirmation'
        : disposition === EXPECTATION_ONLY
          ? 'never — you cannot propose someone else\'s promise (M-1)'
          : 'never — vault-local';
    out.push(`| \`${disposition}\` | ${count} | ${proposable} |`);
  }
  if (dispositions.size === 0) out.push('| — | 0 | — |');
  out.push('');

  if (input.rejectedBatches.length > 0) {
    out.push('### Discarded model responses');
    out.push('');
    out.push(
      'A response that does not validate against §3.1 yields **zero** commitments, never a ' +
        'partial guess (§3.4).',
    );
    out.push('');
    out.push('| Batch | Stage | Detail |');
    out.push('| --- | --- | --- |');
    for (const { batch, rejection } of input.rejectedBatches) {
      const detail =
        rejection.stage === 'response'
          ? `${rejection.rejection.reason}: ${rejection.rejection.detail}`
          : rejection.stage === 'attribution'
            ? rejection.detail
            : `${rejection.failure.reason}: ${rejection.failure.detail}`;
      out.push(`| ${batch} | ${rejection.stage} | ${cell(detail, 160)} |`);
    }
    out.push('');
  }

  out.push('## Findings');
  out.push('');
  if (rows.length === 0) {
    out.push('No commitments were extracted from this window.');
    out.push('');
  } else {
    for (const bucket of BUCKETS) {
      const group = rows.filter((r) => r.confidence >= bucket.min && r.confidence < bucket.max);
      out.push(renderGroup(bucket.name, group));
    }
  }

  out.push('---');
  out.push('');
  out.push(
    'Report content is drawn from private local transcripts. `precision-report.md` is gitignored ' +
      'and must never be committed.',
  );
  out.push('');
  return out.join('\n');
}
