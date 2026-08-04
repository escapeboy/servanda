import { Extractor } from '../extractor.js';
import type { RunRejection } from '../extractor.js';
import type { ModelClient } from '../model.js';
import { readEnvelopeLog } from './log.js';
import type { EnvelopeLogCursor, EnvelopeLogStats } from './log.js';
import { toCandidate } from './sink.js';
import type { IngestCandidate, PendingProposalSink } from './sink.js';

/**
 * Envelope log → §3.4 extraction → the node's confirmation queue.
 *
 * This is the hop that was missing. The Claude Code hook has always written envelopes to
 * `$SERVANDA_ENVELOPE_LOG`; nothing read them, so a person who registered the hook and waited for
 * promises to appear waited forever. What follows reads that file and hands what it finds to a
 * `PendingProposalSink` — and stops there. Nothing here signs, commits, or reaches a wire: the
 * only exit from the queue is still a human act, which is the guarantee §9.2 trades for admitting
 * that extraction can be fooled.
 *
 * **The cursor is an optimisation. `hasIngestedEnvelope` is the correctness.** Every envelope is
 * asked about individually before it costs a model call, so re-reading the log from byte zero —
 * after a rotation, a lost cursor file, a restore from backup — queues nothing twice. The cursor
 * only exists so that the common case does not re-read a year of history to find one new line.
 *
 * That is also why the cursor stops where ingest stopped, not where the read stopped: see
 * `cursorAdvanced` below.
 */

export interface IngestOptions {
  readonly logPath: string;
  /** M-5. One run, one persona; envelopes belonging to anyone else are counted and left. */
  readonly persona: string;
  readonly model: ModelClient;
  readonly sink: PendingProposalSink;
  readonly cursor?: EnvelopeLogCursor;
  readonly batchSize?: number;
  readonly maxBytes?: number;
  readonly resolveParty?: (label: string) => string | null;
  readonly now?: () => string;
}

export interface IngestResult {
  readonly persona: string;
  /**
   * Persist this and pass it to the next run. It is the position of the first envelope this run
   * did NOT ingest, so a rejected batch is read again rather than skipped.
   */
  readonly cursor: EnvelopeLogCursor | undefined;
  /** False when a batch was rejected: the cursor is the one this run started from. */
  readonly cursorAdvanced: boolean;
  /** Absent when the log does not exist yet — the hook has never fired, or is misconfigured. */
  readonly log: EnvelopeLogStats | undefined;
  readonly logMissing: boolean;
  /** Envelopes the sink had already seen. The cost this whole design exists to avoid paying. */
  readonly alreadyIngested: number;
  /** Envelopes sent to the model and marked ingested, whether or not they yielded anything. */
  readonly envelopesIngested: number;
  /** Envelopes read but NOT ingested, because their batch was rejected. Read again next run. */
  readonly envelopesDeferred: number;
  readonly queued: number;
  readonly rejectedBatches: readonly { readonly batch: number; readonly rejection: RunRejection }[];
  readonly modelId: string;
}

function batched<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

export async function ingestEnvelopeLog(options: IngestOptions): Promise<IngestResult> {
  const empty = { persona: options.persona, modelId: options.model.id } as const;

  let read;
  try {
    read = readEnvelopeLog(options.logPath, {
      persona: options.persona,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
  } catch (error) {
    // A log that is not there yet is the ordinary state of a fresh install, not a failure. Every
    // other error — including the not-a-regular-file refusal — is the caller's to see.
    if (!isMissing(error)) throw error;
    return {
      ...empty,
      cursor: options.cursor,
      cursorAdvanced: false,
      log: undefined,
      logMissing: true,
      alreadyIngested: 0,
      envelopesIngested: 0,
      envelopesDeferred: 0,
      queued: 0,
      rejectedBatches: [],
    };
  }

  const startCursor: EnvelopeLogCursor = {
    dev: read.cursor.dev,
    ino: read.cursor.ino,
    offset: read.cursor.offset - read.stats.bytesConsumed,
  };

  const fresh = read.envelopes.filter(
    (e) => !options.sink.hasIngestedEnvelope(options.persona, e.id),
  );
  const alreadyIngested = read.envelopes.length - fresh.length;

  const extractor = new Extractor({
    persona: options.persona,
    model: options.model,
    ...(options.resolveParty === undefined ? {} : { resolveParty: options.resolveParty }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const batches = batched(fresh, options.batchSize ?? 12);
  const rejectedBatches: { batch: number; rejection: RunRejection }[] = [];
  let queued = 0;
  let ingested = 0;
  let deferred = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (batch === undefined) continue;
    let run;
    try {
      run = await extractor.extract(batch);
    } catch (error) {
      rejectedBatches.push({ batch: b + 1, rejection: { stage: 'transport', detail: describe(error) } });
      deferred += batch.length;
      continue;
    }
    if (run.rejection !== undefined) {
      // The whole batch is discarded by §3.4's own rule — "objects valid against §3.1 or nothing".
      // It is NOT marked ingested. That means a batch the model keeps answering badly will be read
      // again on every run and `envelopesDeferred` will stop moving, which is a stall a person can
      // see. The alternative — marking them so the queue drains — silently throws away whatever
      // promises were in those envelopes, and a silent discard in a promise-keeping system is the
      // worse of the two by a long way.
      rejectedBatches.push({ batch: b + 1, rejection: run.rejection });
      deferred += batch.length;
      continue;
    }

    const byEnvelope = new Map<string, IngestCandidate[]>();
    for (const envelope of batch) byEnvelope.set(envelope.id, []);
    for (const item of run.items) {
      byEnvelope.get(item.envelope.id)?.push(
        toCandidate(item.routed, item.raw.quote, item.raw.confidence),
      );
    }
    for (const [envelopeId, candidates] of byEnvelope) {
      // Called for the empty list too: "the model found nothing here" is a result worth recording,
      // and not recording it means paying for the same answer on every run for the life of the log.
      queued += options.sink.ingestEnvelope(options.persona, envelopeId, candidates).length;
      ingested++;
    }
  }

  const cursorAdvanced = deferred === 0;
  return {
    ...empty,
    cursor: cursorAdvanced ? read.cursor : startCursor,
    cursorAdvanced,
    log: read.stats,
    logMissing: false,
    alreadyIngested,
    envelopesIngested: ingested,
    envelopesDeferred: deferred,
    queued,
    rejectedBatches,
  };
}

/**
 * What went wrong, WITHOUT the third party's free text.
 *
 * This used to be `String(e.message).slice(0, 200)`, and the slice was mistaken for a defence.
 * It is a truncation: an error whose message happens to begin with the payload carries it
 * straight through. Demonstrated rather than argued — the same message with the canary at the
 * front leaks and with the canary at 300 characters does not, which means the protection was the
 * position of the text, not any rule.
 *
 * That matters here more than in most catch blocks. `ingest` is built to run unattended and its
 * report is built to be logged, so anything in `detail` becomes a second copy of what §3
 * captured, in a file with none of the vault's protections on it — and the ONE thing the
 * envelope log's own regular-file rule exists to prevent is a second uncontrolled copy.
 *
 * The message is dropped entirely rather than redacted. Redaction means knowing what to look
 * for, which is a denylist, and this repository has already made this exact choice once: the
 * writer's target check is `fstat` says regular file, not a list of bad paths. One rule that
 * cannot be evaded beats a filter that can be, and an SDK that escapes or encodes the payload
 * would defeat any matcher.
 *
 * What survives is what an operator actually acts on: which class of failure, and the status.
 * "Rate limited" and "bad request" and "the network is down" are different responses, and all
 * three are visible here. What is lost is the vendor's sentence, which is a real loss and is the
 * price of the guarantee.
 */
function describe(error: unknown): string {
  const e = error as { status?: unknown; name?: unknown };
  const status = typeof e?.status === 'number' ? ` (HTTP ${e.status})` : '';
  const kind =
    typeof e?.name === 'string' && e.name.length > 0
      ? e.name
      : (error as object)?.constructor?.name ?? 'unknown error';
  return `${kind}${status}`;
}
