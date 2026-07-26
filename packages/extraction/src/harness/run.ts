import { writeFileSync } from 'node:fs';
import { Extractor } from '../extractor.js';
import type { RunRejection } from '../extractor.js';
import { createAnthropicModelClient, DEFAULT_MODEL } from '../model.js';
import type { ModelClient } from '../model.js';
import { PendingConfirmationQueue } from '../pending.js';
import { EXPECTATION_ONLY } from '../routing.js';
import { createStubModelClient } from '../stub.js';
import { renderReport } from './report.js';
import type { ReportRow } from './report.js';
import { harnessPersona, normalizeRfc3339, scanTranscripts } from './transcripts.js';
import type { ScanResult, Utterance } from './transcripts.js';

/**
 * The precision harness.
 *
 * Reads local transcripts, runs §3.4 extraction over the last N days, routes every result, drops
 * it in a pending-confirmation queue, and writes a report a human can grade. It writes exactly
 * one file — the report — and touches no protocol state.
 */

export interface HarnessOptions {
  readonly dryRun?: boolean;
  readonly days?: number;
  readonly root?: string;
  readonly out?: string;
  readonly batchSize?: number;
  readonly maxTranscripts?: number;
  readonly maxUtterancesPerTranscript?: number;
  readonly maxEnvelopes?: number;
  readonly personaLabel?: string;
  readonly model?: string;
  readonly apiKey?: string | undefined;
  /** Injected in tests; otherwise chosen from `dryRun` + the presence of an API key. */
  readonly modelClient?: ModelClient;
  /**
   * Declares an injected client to be a REAL model rather than a stand-in. Injection defaults to
   * 'stub' because that is what tests inject; a backend that genuinely calls a model must say so,
   * or the report would warn readers off findings that are in fact real.
   */
  readonly modelClientMode?: 'stub' | 'live';
  /** How that backend reaches the model, for the report's provenance row. */
  readonly modelClientNote?: string;
  /** Attempts per batch before it is recorded as a transport failure. */
  readonly retries?: number;
  /** Characters of each utterance sent for extraction; 0 disables clipping. */
  readonly maxUtteranceChars?: number;
  readonly now?: Date;
}

export interface HarnessResult {
  readonly markdown: string;
  readonly rows: readonly ReportRow[];
  readonly scan: ScanResult['stats'];
  readonly queue: PendingConfirmationQueue;
  readonly rejectedBatches: readonly { readonly batch: number; readonly rejection: RunRejection }[];
  readonly mode: 'stub' | 'live';
  readonly liveRunSkippedReason?: string;
}

const CONTEXT_RADIUS = 320;

function contextAround(utterance: Utterance, quote: string): string {
  const text = utterance.text;
  if (text.length <= CONTEXT_RADIUS * 2) return text;
  const at = text.indexOf(quote);
  if (at < 0) return `${text.slice(0, CONTEXT_RADIUS * 2)}\n[…]`;
  const from = Math.max(0, at - CONTEXT_RADIUS);
  const to = Math.min(text.length, at + quote.length + CONTEXT_RADIUS);
  return `${from > 0 ? '[…] ' : ''}${text.slice(from, to)}${to < text.length ? ' […]' : ''}`;
}

function describeError(error: unknown): string {
  const e = error as { message?: unknown; status?: unknown };
  const status = typeof e?.status === 'number' ? ` (HTTP ${e.status})` : '';
  return `${String(e?.message ?? error).slice(0, 200)}${status}`;
}

/** Exponential backoff. Deterministic delays — no jitter — so a run stays reproducible. */
async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

function batched<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runHarness(options: HarnessOptions = {}): Promise<HarnessResult> {
  const now = options.now ?? new Date();
  const scan = scanTranscripts({
    root: options.root,
    days: options.days,
    persona: options.personaLabel === undefined ? undefined : harnessPersona(options.personaLabel),
    maxTranscripts: options.maxTranscripts,
    maxUtterancesPerTranscript: options.maxUtterancesPerTranscript,
    maxEnvelopes: options.maxEnvelopes,
    ...(options.maxUtteranceChars === undefined ? {} : { maxUtteranceChars: options.maxUtteranceChars }),
    now,
  });

  const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
  const wantsLive = options.dryRun !== true;
  let mode: 'stub' | 'live' = 'stub';
  let liveRunSkippedReason: string | undefined;
  let model: ModelClient;

  if (options.modelClient !== undefined) {
    model = options.modelClient;
    mode = options.modelClientMode ?? 'stub';
    if (mode === 'stub') liveRunSkippedReason = 'an injected model client was supplied';
  } else if (wantsLive && apiKey !== undefined && apiKey !== '') {
    model = createAnthropicModelClient({ model: options.model ?? DEFAULT_MODEL });
    mode = 'live';
  } else {
    model = createStubModelClient();
    liveRunSkippedReason = wantsLive
      ? 'ANTHROPIC_API_KEY is not set in the environment'
      : '--dry-run was requested';
  }

  const extractor = new Extractor({
    persona: scan.persona,
    model,
    now: () => normalizeRfc3339(now.toISOString()),
  });

  const queue = new PendingConfirmationQueue();
  const rows: ReportRow[] = [];
  const rejectedBatches: { batch: number; rejection: RunRejection }[] = [];
  const batches = batched(scan.envelopes, options.batchSize ?? 12);

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (batch === undefined) continue;
    // A harness over a hundred sequential network calls must survive one of them failing.
    // Losing 108 good batches to a single transient connection error is not a result, it is an
    // outage — and an aborted run silently under-reports rather than reporting less.
    let run;
    try {
      run = await withRetry(() => extractor.extract(batch), options.retries ?? 3);
    } catch (error) {
      rejectedBatches.push({
        batch: b + 1,
        rejection: { stage: 'transport', detail: describeError(error) },
      });
      continue;
    }
    if (run.rejection !== undefined) {
      rejectedBatches.push({ batch: b + 1, rejection: run.rejection });
      continue;
    }
    for (const item of run.items) {
      const utterance = scan.sources.get(item.envelope.id);
      const pending = queue.enqueue({
        routed: item.routed,
        envelopeId: item.envelope.id,
        quote: item.raw.quote,
        confidence: item.raw.confidence,
        queuedAt: normalizeRfc3339(now.toISOString()),
      });
      const isExpectation = item.routed.disposition === EXPECTATION_ONLY;
      rows.push({
        ref: `C-${String(rows.length + 1).padStart(3, '0')}`,
        intent: isExpectation ? item.routed.expectation.expect : item.routed.commitment.intent,
        owner: isExpectation ? item.routed.from : item.routed.commitment.owner,
        owedTo: isExpectation
          ? 'local-user (awaited by)'
          : (item.routed.commitment.owed_to ?? '—'),
        due: isExpectation ? null : item.routed.commitment.due,
        confidence: item.raw.confidence,
        disposition: item.routed.disposition,
        objectType: isExpectation ? 'expectation' : 'commitment',
        quote: item.raw.quote,
        context: utterance ? contextAround(utterance, item.raw.quote) : item.raw.quote,
        transcript: utterance?.file ?? '(unknown)',
        transcriptLine: utterance?.line ?? 0,
        occurredAt: item.envelope.occurred_at,
        envelopeId: item.envelope.id,
        pendingId: pending.id,
      });
    }
  }

  const markdown = renderReport({
    generatedAt: normalizeRfc3339(now.toISOString()),
    mode,
    modelId: model.id,
    modeNote: options.modelClientNote,
    persona: scan.persona,
    scan: scan.stats,
    batches: batches.length,
    rejectedBatches,
    rows,
    ...(liveRunSkippedReason !== undefined ? { liveRunSkippedReason } : {}),
  });

  if (options.out !== undefined) writeFileSync(options.out, markdown, 'utf8');

  return {
    markdown,
    rows,
    scan: scan.stats,
    queue,
    rejectedBatches,
    mode,
    ...(liveRunSkippedReason !== undefined ? { liveRunSkippedReason } : {}),
  };
}

export interface ParsedArgs extends HarnessOptions {
  readonly help?: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case '--dry-run':
        out['dryRun'] = true;
        break;
      case '--help':
      case '-h':
        out['help'] = true;
        break;
      case '--days':
        out['days'] = Number(next());
        break;
      case '--root':
        out['root'] = next();
        break;
      case '--out':
        out['out'] = next();
        break;
      case '--batch-size':
        out['batchSize'] = Number(next());
        break;
      case '--max-transcripts':
        out['maxTranscripts'] = Number(next());
        break;
      case '--max-utterances-per-transcript':
        out['maxUtterancesPerTranscript'] = Number(next());
        break;
      case '--max-envelopes':
        out['maxEnvelopes'] = Number(next());
        break;
      case '--max-utterance-chars':
        out['maxUtteranceChars'] = Number(next());
        break;
      case '--model':
        out['model'] = next();
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out as ParsedArgs;
}

export const USAGE = `servanda-precision — §3.4 extraction precision harness (read-only)

  --dry-run                          use the deterministic stub model (no API calls, no spend)
  --days N                           window to scan (default 30)
  --root PATH                        transcript root (default ~/.claude/projects)
  --out PATH                         report path (default ./precision-report.md)
  --batch-size N                     envelopes per model call (default 12)
  --max-transcripts N                cap transcripts scanned (0 = no cap)
  --max-utterances-per-transcript N  cap utterances taken from each transcript
  --max-envelopes N                  cap total envelopes
  --model ID                         model id for the live path (default ${DEFAULT_MODEL})

The harness never writes to a vault, a ledger, or the wire, and never modifies a transcript.
Without ANTHROPIC_API_KEY it runs the stub path and says so in the report.`;

export async function main(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const out = args.out ?? 'precision-report.md';
  const result = await runHarness({ ...args, out });
  process.stdout.write(
    [
      `mode:                 ${result.mode}`,
      `transcripts scanned:  ${result.scan.transcriptsScanned} of ${result.scan.transcriptsFound} in window`,
      `envelopes produced:   ${result.scan.envelopes}`,
      `malformed lines:      ${result.scan.linesMalformed}`,
      `results extracted:    ${result.rows.length}`,
      `batches discarded:    ${result.rejectedBatches.length}`,
      `pending confirmation: ${result.queue.size} (nothing committed)`,
      `report:               ${out}`,
      '',
    ].join('\n'),
  );
  if (result.liveRunSkippedReason !== undefined) {
    process.stdout.write(`live path NOT exercised: ${result.liveRunSkippedReason}\n`);
  }
  return 0;
}
