import type { IngestResult, ModelClient } from '@servanda/extraction';
import { ingestEnvelopeLog } from '@servanda/extraction';
import { LocalPendingSink, type ServandaNode } from '@servanda/node';
import type { LocalStore } from '@servanda/vault';

/**
 * The loop nobody was running.
 *
 * `ingestEnvelopeLog` is ONE iteration: it reads up to a byte budget, extracts, queues, and
 * hands back a cursor. Something has to call it until the log is exhausted and save the cursor
 * between calls, and for three sprints that something did not exist — the chain was joined as a
 * library and a person who registered the hook still saw nothing.
 *
 * **This package exists for a dependency reason, not an aesthetic one.** `@servanda/node` must
 * not import `@servanda/extraction` at runtime: that package depends on `@anthropic-ai/sdk`, and
 * M-10 says an L0–L1 node functions with no network at all. `@servanda/extraction` must not
 * import the node either — an extraction package able to reach a vault is one a model's output
 * could reach a vault through. Neither may point at the other, so a third package points at both.
 * `@servanda/client-local` exists for exactly the same reason on the client side.
 *
 * A one-shot command rather than a daemon, deliberately. A process that watches a prompt log
 * continuously is a standing capture posture — everything typed at an agent, read and sent to a
 * model, without anybody being asked again. A command is invoked: visible, stoppable, and
 * composable with cron or launchd by whoever decides they want that.
 */

export interface IngestRunOptions {
  readonly node: ServandaNode;
  readonly local: LocalStore;
  readonly persona: string;
  readonly logPath: string;
  readonly model: ModelClient;
  /**
   * A ceiling on iterations, because the loop's exit condition comes from the thing it is
   * reading. A log that keeps reporting an exhausted budget without advancing would spin for
   * ever and spend money doing it; this stops and says so rather than being trusted.
   */
  readonly maxRounds?: number;
  readonly now?: () => string;
}

export interface IngestRunReport {
  readonly rounds: number;
  readonly envelopesIngested: number;
  readonly alreadyIngested: number;
  readonly queued: number;
  readonly deferred: number;
  readonly logMissing: boolean;
  /** Stopped at `maxRounds` with the log still unfinished. Reported, never silent. */
  readonly incomplete: boolean;
  readonly rejectedBatches: number;
  readonly modelId: string;
}

const DEFAULT_MAX_ROUNDS = 50;

export async function runIngest(opts: IngestRunOptions): Promise<IngestRunReport> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const sink = new LocalPendingSink(opts.node);

  let cursor = opts.local.readCursor(opts.persona) ?? undefined;
  let rounds = 0;
  let envelopesIngested = 0;
  let alreadyIngested = 0;
  let queued = 0;
  let deferred = 0;
  let rejectedBatches = 0;
  let logMissing = false;
  let modelId = opts.model.id;

  for (;;) {
    const result: IngestResult = await ingestEnvelopeLog({
      logPath: opts.logPath,
      persona: opts.persona,
      model: opts.model,
      sink,
      ...(cursor === undefined ? {} : { cursor }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    rounds += 1;
    envelopesIngested += result.envelopesIngested;
    alreadyIngested += result.alreadyIngested;
    queued += result.queued;
    deferred = result.envelopesDeferred;
    rejectedBatches += result.rejectedBatches.length;
    modelId = result.modelId;

    if (result.logMissing) {
      logMissing = true;
      break;
    }

    // The cursor is saved ONLY when ingest advanced it. A batch §3.4 rejected leaves it where it
    // was on purpose — those envelopes are deferred, not lost, and writing past them would drop
    // promises silently. That means a permanently-rejecting batch stalls the walk, which is the
    // trade the reader chose: a visible stall over an invisible loss. `deferred` is what shows it.
    if (result.cursorAdvanced && result.cursor !== undefined) {
      opts.local.writeCursor(opts.persona, result.cursor);
      cursor = result.cursor;
    }

    if (result.log?.budgetExhausted !== true) {
      return {
        rounds,
        envelopesIngested,
        alreadyIngested,
        queued,
        deferred,
        logMissing,
        incomplete: false,
        rejectedBatches,
        modelId,
      };
    }
    // Budget exhausted AND nothing moved: another round would read the same bytes and pay for
    // the same answer. Stopping is the only honest option, and it is reported as incomplete.
    if (!result.cursorAdvanced) break;
    if (rounds >= maxRounds) break;
  }

  return {
    rounds,
    envelopesIngested,
    alreadyIngested,
    queued,
    deferred,
    logMissing,
    incomplete: !logMissing,
    rejectedBatches,
    modelId,
  };
}
